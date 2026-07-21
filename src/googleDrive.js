'use strict';

// 隅消息上稿系統 — Google Drive 整合
// 文章 Markdown 不建子資料夾，直接把「編號_標題.md」上傳到 DRIVE_ROOT_FOLDER_ID 底下；
// 配圖則上傳到 DRIVE_ROOT_FOLDER_ID 底下固定的「picture」資料夾，檔名為「編號_序號.副檔名」。

const { google } = require('googleapis');
const { Readable } = require('stream');
const { missingAuthEnv, getAuthClient } = require('./googleAuth');

// 單一 API 呼叫的 timeout（毫秒）。
const API_TIMEOUT_MS = 30000;

// 檔名中標題部分的截斷長度。
const TITLE_MAX_LENGTH = 40;

// 存放所有配圖的固定資料夾名稱（位於 DRIVE_ROOT_FOLDER_ID 底下）。
const PICTURE_FOLDER_NAME = 'picture';

// 不合法的檔名字元（Windows / Drive 皆不建議使用）。
const INVALID_CHARS_REGEX = /[/\\:*?"<>|]/g;
// 控制字元（ASCII 0-31）。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x1f]/g;

// 「picture」資料夾 ID 快取，避免每次上稿都重新查詢/建立。
let cachedPictureFolderId = null;

/**
 * 檢查上傳檔案所需的環境變數。
 * @returns {string[]} 缺少的環境變數名稱陣列
 */
function missingEnv() {
  const missing = [];
  if (missingAuthEnv().length > 0) {
    missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
  if (typeof rootFolderId !== 'string' || rootFolderId.trim() === '') {
    missing.push('DRIVE_ROOT_FOLDER_ID');
  }
  return missing;
}

/**
 * 清理標題：移除不合法字元與控制字元、trim、截斷至 40 字元。
 * 使用字串 slice（BMP 中文字元皆為單一 code unit，可接受）。
 * @param {string} title
 * @returns {string}
 */
function sanitizeTitle(title) {
  const cleaned = String(title == null ? '' : title)
    .replace(INVALID_CHARS_REGEX, '')
    .replace(CONTROL_CHARS_REGEX, '')
    .trim();

  return Array.from(cleaned).slice(0, TITLE_MAX_LENGTH).join('');
}

/**
 * 取得 Drive API client。
 * 若 .env 有 GOOGLE_OAUTH_REFRESH_TOKEN 則用個人帳號 OAuth2（有 Drive 配額）；
 * 否則 fallback 到 Service Account（個人帳號需前者才能上傳檔案）。
 * @returns {import('googleapis').drive_v3.Drive}
 */
function getDriveClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: 'v3', auth: oauth2 });
  }

  const auth = getAuthClient();
  return google.drive({ version: 'v3', auth });
}

/**
 * 將 Google API 的錯誤包裝成清楚的中文錯誤訊息。
 * @param {unknown} err 原始錯誤
 * @param {string} action 動作描述（用於錯誤訊息開頭）
 * @returns {Error}
 */
function wrapApiError(err, action) {
  const status = err && (err.code || (err.response && err.response.status));
  const summary = (err && err.message) || String(err);

  let hint = '';
  if (status === 403 || status === 404) {
    hint =
    '請確認資料夾已分享給 Service Account 的 email（編輯權限）且 ID 正確';
  }

  const statusText = status ? `HTTP ${status}` : '未知狀態';
  return new Error(
    `${action}失敗（${statusText}）：${summary}${hint ? '，' + hint : ''}`
  );
}

/**
 * 上傳檔案到指定資料夾。
 * @param {string} folderId 目標資料夾 ID
 * @param {string} name 檔案名稱
 * @param {Buffer|string} content 檔案內容
 * @param {string} mimeType 檔案的 MIME type
 * @returns {Promise<{ fileId: string }>}
 */
async function uploadFile(folderId, name, content, mimeType) {
  const missing = missingAuthEnv();
  if (missing.length > 0) {
    throw new Error(
      `Google Drive 未設定（缺少 ${missing.join('、')}），無法上傳檔案`
    );
  }

  const drive = getDriveClient();
  const body = Readable.from(content);

  let response;
  try {
    response = await drive.files.create(
      {
        supportsAllDrives: true,
        requestBody: {
          name,
          parents: [folderId],
        },
        media: {
          mimeType,
          body,
        },
        fields: 'id',
      },
      { timeout: API_TIMEOUT_MS }
    );
  } catch (err) {
    throw wrapApiError(err, `上傳檔案「${name}」`);
  }

  return { fileId: response.data.id };
}

/**
 * 取得（必要時建立）固定的「picture」資料夾 ID，位於 DRIVE_ROOT_FOLDER_ID 底下。
 * 找過一次後快取在記憶體中，同一次程式執行期間不會重複查詢。
 * @returns {Promise<string>}
 */
async function getPictureFolderId() {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(
      `Google Drive 未設定（缺少 ${missing.join('、')}），無法取得 picture 資料夾`
    );
  }

  if (cachedPictureFolderId) {
    return cachedPictureFolderId;
  }

  const drive = getDriveClient();
  const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;

  let listResponse;
  try {
    listResponse = await drive.files.list(
      {
        q: `name = '${PICTURE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed = false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      { timeout: API_TIMEOUT_MS }
    );
  } catch (err) {
    throw wrapApiError(err, '查詢 picture 資料夾');
  }

  const existing = listResponse.data.files && listResponse.data.files[0];
  if (existing && existing.id) {
    cachedPictureFolderId = existing.id;
    return cachedPictureFolderId;
  }

  let createResponse;
  try {
    createResponse = await drive.files.create(
      {
        supportsAllDrives: true,
        requestBody: {
          name: PICTURE_FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [rootFolderId],
        },
        fields: 'id',
      },
      { timeout: API_TIMEOUT_MS }
    );
  } catch (err) {
    throw wrapApiError(err, '建立 picture 資料夾');
  }

  cachedPictureFolderId = createResponse.data.id;
  return cachedPictureFolderId;
}

/**
 * 把文章 Markdown 直接上傳到 DRIVE_ROOT_FOLDER_ID 底下（不建子資料夾），
 * 檔名為「編號_標題.md」（標題已 sanitize 並截斷）。
 * @param {object} params
 * @param {number} params.number 文章編號
 * @param {string} params.title 文章標題
 * @param {string} params.content 文章 Markdown 內容
 * @returns {Promise<{ fileId: string, fileUrl: string, filename: string }>}
 */
async function uploadArticleMarkdown({ number, title, content }) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(
      `Google Drive 未設定（缺少 ${missing.join('、')}），無法上傳文章檔案`
    );
  }

  const filename = `${number}_${sanitizeTitle(title)}.md`;
  const { fileId } = await uploadFile(
    process.env.DRIVE_ROOT_FOLDER_ID,
    filename,
    content,
    'text/markdown'
  );

  return {
    fileId,
    fileUrl: `https://drive.google.com/file/d/${fileId}/view`,
    filename,
  };
}

module.exports = {
  missingEnv,
  sanitizeTitle,
  uploadFile,
  uploadArticleMarkdown,
  getPictureFolderId,
};
