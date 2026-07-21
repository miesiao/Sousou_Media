'use strict';

// 隅消息上稿系統 — 上稿 orchestration
// 依序執行：下載選定配圖 → WordPress 草稿 → 取得文章編號(讀 Sheets) → Drive 存檔(.md) → Sheets 記錄一列。
// 任一步失敗要明確回報到哪一步，並保留已成功的部分(不自動回滾，讓人工補救)。
// 每一步動作前先用該模組 missingEnv() 檢查，缺變數時在「動作發生前」就標記該步失敗。

const { marked } = require('marked');

const wordpress = require('./wordpress');
const googleDrive = require('./googleDrive');
const sheets = require('./sheets');
const { triggerDownload } = require('./imageSearch/unsplash');

// 外部呼叫的 timeout 上限(毫秒)。
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30 * 1000; // 單張原圖下載 30s
const EXTERNAL_CALL_TIMEOUT_MS = 30 * 1000;  // WP / Drive / Sheets 模組呼叫 30s

/**
 * 為任意 Promise 加上 timeout 保護，逾時以清楚訊息 reject。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label 用於錯誤訊息的中文動作名稱
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}逾時(超過 ${Math.round(ms / 1000)} 秒)`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * 取得台灣(Asia/Taipei)當前日期字串。
 * @returns {{ dash: string, compact: string }} dash: YYYY-MM-DD、compact: YYYYMMDD
 */
function getTodayStrings() {
  // en-CA 產生 YYYY-MM-DD 格式。
  const dash = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return { dash, compact: dash.replace(/-/g, '') };
}

/**
 * 基本 HTML 逸出(用於附文末的 figure 標籤內容)。
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// content-type → 副檔名對照，找不到時預設 jpg。
const EXT_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * 依實際下載到的 content-type 取得對應副檔名，避免非 JPEG 圖被硬寫成 .jpg
 * 導致 WordPress 副檔名/內容比對失敗。
 * @param {string} contentType
 * @returns {string}
 */
function extFromContentType(contentType) {
  return EXT_BY_CONTENT_TYPE[contentType] || 'jpg';
}

/**
 * 下載單張原圖(AbortController timeout 30s)。
 * @param {object} candidate
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function downloadImage(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(candidate.fullUrl, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`下載回應狀態碼 ${resp.status}`);
    }
    // 取 content-type，去掉 charset 等參數，預設 image/jpeg。
    const rawType = resp.headers.get('content-type') || 'image/jpeg';
    const contentType = rawType.split(';')[0].trim() || 'image/jpeg';
    const arrayBuffer = await resp.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 步驟 1：依 selectedIds 下載選定原圖(保持選取順序，第一張為 featured)。
 * @param {object} task
 * @param {string[]} selectedIds
 * @returns {Promise<{ images: Array, errors: string[] }>}
 */
async function downloadSelectedImages(task, selectedIds) {
  const images = [];
  const errors = [];

  for (const id of selectedIds) {
    const candidate = task.candidates.find((c) => c.id === id);
    if (!candidate) {
      errors.push(`找不到選取的圖片(id: ${id})`);
      continue;
    }

    try {
      const { buffer, contentType } = await downloadImage(candidate);

      // Unsplash 圖成功下載後需回報下載(API 規範)，失敗僅警告不中斷。
      if (candidate.source === 'unsplash' && candidate.downloadLocation) {
        try {
          await triggerDownload(candidate.downloadLocation);
        } catch (err) {
          console.warn('[publish] Unsplash triggerDownload 失敗(略過)：', err && err.message);
        }
      }

      images.push({ candidate, buffer, contentType });
    } catch (err) {
      console.error(`[publish] 圖片下載失敗(id: ${id})：`, err && err.message);
      errors.push(`圖片下載失敗(${candidate.source}, id: ${id})：${err && err.message}`);
    }
  }

  return { images, errors };
}

/**
 * 步驟 2：WordPress 草稿(上傳圖片 + 建立草稿)。
 * @returns {Promise<object>} wordpress step 結果 + 內部 editUrl
 */
async function stepWordpress(task, images) {
  // 動作前先檢查環境變數。
  const miss = wordpress.missingEnv();
  if (miss.length > 0) {
    const message = `WordPress 未設定(缺少 ${miss.join('、')})，已略過此步驟`;
    console.error('[publish] ' + message);
    return { status: 'error', message, draftEditUrl: '', draftId: null, editUrl: '' };
  }

  try {
    const { compact } = getTodayStrings();

    // Markdown → 乾淨標準 HTML(只用標準 post_content，絕不寫 Elementor meta)。
    let html = marked.parse(task.markdown);

    let featuredMediaId = null;
    const uploadWarnings = [];
    let uploadedCount = 0;

    for (let i = 0; i < images.length; i += 1) {
      const { candidate } = images[i];
      const n = i + 1;
      const filename = `sousou-${compact}-${n}.${extFromContentType(images[i].contentType)}`;

      try {
        const uploaded = await withTimeout(
          wordpress.uploadImage({
            buffer: images[i].buffer,
            filename,
            contentType: images[i].contentType,
            caption: candidate.attribution,
            altText: task.title,
          }),
          EXTERNAL_CALL_TIMEOUT_MS,
          'WordPress 圖片上傳'
        );
        uploadedCount += 1;

        if (featuredMediaId === null) {
          // 第 1 張成功者當 featured_media。
          featuredMediaId = uploaded.id;
        } else {
          // 第 2 張起附加在文末(規格允許簡單版：全部附文末)。
          const src = escapeHtml(uploaded.sourceUrl);
          const cap = escapeHtml(candidate.attribution);
          html += `\n<figure><img src="${src}"><figcaption>${cap}</figcaption></figure>`;
        }
      } catch (err) {
        console.error('[publish] WordPress 圖片上傳失敗：', err && err.message);
        uploadWarnings.push(`第 ${n} 張上傳失敗：${err && err.message}`);
      }
    }

    const draft = await withTimeout(
      wordpress.createDraft({ title: task.title, html, featuredMediaId }),
      EXTERNAL_CALL_TIMEOUT_MS,
      'WordPress 建立草稿'
    );

    let message = `已建立 WordPress 草稿(上傳 ${uploadedCount} 張圖)`;
    if (uploadWarnings.length > 0) {
      message += `；部分圖片上傳失敗：${uploadWarnings.join('；')}`;
    }

    return {
      status: 'ok',
      message,
      draftEditUrl: draft.editUrl || '',
      draftId: draft.id != null ? draft.id : null,
      editUrl: draft.editUrl || '',
    };
  } catch (err) {
    const message = `WordPress 建立草稿失敗：${err && err.message}`;
    console.error('[publish] ' + message);
    return { status: 'error', message, draftEditUrl: '', draftId: null, editUrl: '' };
  }
}

/**
 * 組出上傳到 Drive 的文章 Markdown 內容：開頭確保有 # {title} 的 H1(已有相同標題則不重複)。
 * @param {object} task
 * @returns {string}
 */
function buildArticleMarkdown(task) {
  const trimmed = task.markdown.replace(/^﻿/, '').trimStart();
  const firstLine = trimmed.split('\n')[0].trim();
  const expectedHeading = `# ${task.title}`.trim();

  if (firstLine === expectedHeading) {
    return task.markdown;
  }
  return `# ${task.title}\n\n${task.markdown}`;
}

/**
 * 步驟：Google Drive 存檔。
 * 文章 Markdown 直接上傳到根資料夾(不建子資料夾)，檔名為「編號_標題.md」；
 * 配圖(若有選圖且成功下載)上傳到固定的「picture」資料夾，檔名為「編號_序號.副檔名」
 * (序號與選取順序一致，第 1 張即 WordPress 的精選圖片)。
 * @param {object} task
 * @param {Array} images 已下載的配圖(順序即選取順序)
 * @param {number} number 文章編號(與 Sheets 那一列共用同一個編號)
 * @returns {Promise<object>} drive step 結果 + 內部 fileUrl
 */
async function stepDrive(task, images, number) {
  const miss = googleDrive.missingEnv();
  if (miss.length > 0) {
    const message = `Google Drive 未設定(缺少 ${miss.join('、')})，已略過此步驟`;
    console.error('[publish] ' + message);
    return { status: 'error', message, fileUrl: '' };
  }

  const fileErrors = [];
  let fileUrl = '';
  let articleFilename = '';

  // 文章 Markdown。
  try {
    const uploaded = await withTimeout(
      googleDrive.uploadArticleMarkdown({
        number,
        title: task.title,
        content: buildArticleMarkdown(task),
      }),
      EXTERNAL_CALL_TIMEOUT_MS,
      'Google Drive 上傳文章檔案'
    );
    fileUrl = uploaded.fileUrl || '';
    articleFilename = uploaded.filename || '';
  } catch (err) {
    console.error('[publish] Drive 上傳文章檔案失敗：', err && err.message);
    fileErrors.push(`文章檔案：${err && err.message}`);
  }

  // 配圖(有選圖才上傳)：picture 資料夾內，檔名「編號_序號.副檔名」。
  let uploadedImageCount = 0;
  if (images.length > 0) {
    try {
      const pictureFolderId = await withTimeout(
        googleDrive.getPictureFolderId(),
        EXTERNAL_CALL_TIMEOUT_MS,
        'Google Drive 取得 picture 資料夾'
      );

      for (let i = 0; i < images.length; i += 1) {
        const name = `${number}_${i + 1}.${extFromContentType(images[i].contentType)}`;
        try {
          await withTimeout(
            googleDrive.uploadFile(
              pictureFolderId,
              name,
              images[i].buffer,
              images[i].contentType || 'image/jpeg'
            ),
            EXTERNAL_CALL_TIMEOUT_MS,
            `Google Drive 上傳 ${name}`
          );
          uploadedImageCount += 1;
        } catch (err) {
          console.error(`[publish] Drive 上傳 ${name} 失敗：`, err && err.message);
          fileErrors.push(`${name}：${err && err.message}`);
        }
      }
    } catch (err) {
      console.error('[publish] Drive 取得 picture 資料夾失敗：', err && err.message);
      fileErrors.push(`picture 資料夾：${err && err.message}`);
    }
  }

  if (fileErrors.length > 0) {
    const message = articleFilename
      ? `已存檔到 Google Drive(${articleFilename})，但部分檔案上傳失敗：${fileErrors.join('；')}`
      : `Google Drive 存檔失敗：${fileErrors.join('；')}`;
    return { status: 'error', message, fileUrl };
  }

  let message = `已存檔到 Google Drive(${articleFilename})`;
  if (uploadedImageCount > 0) {
    message += `，並上傳 ${uploadedImageCount} 張圖片到 picture 資料夾`;
  }
  return { status: 'ok', message, fileUrl };
}

/**
 * 步驟：Google Sheets 記錄一列(編號、日期、上稿狀態、題目)。
 * @param {object} task
 * @param {number} number 文章編號(與 Drive 檔名共用同一個編號)
 * @returns {Promise<object>} sheets step 結果
 */
async function stepSheets(task, number) {
  const miss = sheets.missingEnv();
  if (miss.length > 0) {
    const message = `Google Sheets 未設定(缺少 ${miss.join('、')})，已略過此步驟`;
    console.error('[publish] ' + message);
    return { status: 'error', message };
  }

  try {
    const { dash } = getTodayStrings();
    await withTimeout(
      sheets.appendRow({ number, date: dash, title: task.title }),
      EXTERNAL_CALL_TIMEOUT_MS,
      'Google Sheets 記錄'
    );
    return { status: 'ok', message: `已記錄到 Google Sheets(編號 ${number})` };
  } catch (err) {
    const message = `Google Sheets 記錄失敗：${err && err.message}`;
    console.error('[publish] ' + message);
    return { status: 'error', message };
  }
}

/**
 * 上稿主流程。依序執行下載配圖 → WordPress → 取得文章編號 → Drive → Sheets，
 * 保留已成功部分，回報每一步的狀態(不自動回滾)。
 * Drive 檔名與 Sheets 列使用同一個文章編號(來自 Sheets 目前最大編號 + 1)，
 * 因此編號一定要先取得成功，Drive／Sheets 兩步才會執行。
 * @param {object} task { title, markdown, candidates }
 * @param {string[]} selectedIds 選取的圖片 id(順序即排序，第一張為 featured)
 * @returns {Promise<object>} 與前端契約一致的結果物件
 */
async function publishArticle(task, selectedIds) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];

  // ---- 步驟 1：下載選定原圖 ----
  let images = [];
  let imagesStep;
  if (ids.length === 0) {
    // 未選圖 = 跳過配圖。
    imagesStep = { status: 'skipped', message: '未選擇配圖', downloaded: 0 };
  } else {
    const { images: downloaded, errors } = await downloadSelectedImages(task, ids);
    images = downloaded;
    if (downloaded.length === 0) {
      imagesStep = {
        status: 'error',
        message: `所有選取的圖片皆下載失敗：${errors.join('；')}`,
        downloaded: 0,
      };
    } else if (errors.length > 0) {
      imagesStep = {
        status: 'ok',
        message: `已下載 ${downloaded.length} 張圖；部分失敗：${errors.join('；')}`,
        downloaded: downloaded.length,
      };
    } else {
      imagesStep = {
        status: 'ok',
        message: `已下載 ${downloaded.length} 張圖`,
        downloaded: downloaded.length,
      };
    }
  }

  // ---- 步驟 2：WordPress ----
  const wp = await stepWordpress(task, images);

  // ---- 步驟 3：取得文章編號(Drive 檔名與 Sheets 列共用) ----
  const sheetsMiss = sheets.missingEnv();
  let articleNumber = null;
  let numberErrorMessage = null;
  if (sheetsMiss.length > 0) {
    numberErrorMessage = `Google Sheets 未設定(缺少 ${sheetsMiss.join('、')})，無法取得文章編號`;
  } else {
    try {
      articleNumber = await withTimeout(
        sheets.getNextArticleNumber(),
        EXTERNAL_CALL_TIMEOUT_MS,
        'Google Sheets 讀取文章編號'
      );
    } catch (err) {
      numberErrorMessage = `取得文章編號失敗：${err && err.message}`;
      console.error('[publish] ' + numberErrorMessage);
    }
  }

  // ---- 步驟 4：Google Drive ----
  const drive = articleNumber !== null
    ? await stepDrive(task, images, articleNumber)
    : { status: 'error', message: `${numberErrorMessage}，已略過 Drive 存檔`, fileUrl: '' };

  // ---- 步驟 5：Google Sheets ----
  const sheetsResult = articleNumber !== null
    ? await stepSheets(task, articleNumber)
    : { status: 'error', message: numberErrorMessage || 'Google Sheets 未設定，已略過此步驟' };

  const steps = {
    images: imagesStep,
    wordpress: {
      status: wp.status,
      message: wp.message,
      draftEditUrl: wp.draftEditUrl,
      draftId: wp.draftId,
    },
    drive: {
      status: drive.status,
      message: drive.message,
      fileUrl: drive.fileUrl,
    },
    sheets: {
      status: sheetsResult.status,
      message: sheetsResult.message,
    },
  };

  // 五步皆 ok 或 skipped 才算整體成功。
  const ok = Object.values(steps).every(
    (step) => step.status === 'ok' || step.status === 'skipped'
  );

  return { ok, steps };
}

module.exports = { publishArticle };
