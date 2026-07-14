'use strict';

// 隅消息上稿系統 — WordPress REST API 整合模組
// 規格第 6 節：Basic Auth 認證、上傳圖片、建立草稿。
// 重要限制：絕對不寫入任何 Elementor 相關 meta（例如 _elementor_data），
// 文章一律以標準 post_content（HTML）呈現；草稿一律 status: "draft"，絕不自動發佈。
// Markdown → HTML 的轉換由呼叫端負責，本模組只處理 HTML 字串。

// 本模組需要的環境變數（順序即錯誤訊息中出現的順序）。
const REQUIRED_ENV_NAMES = ['WP_BASE_URL', 'WP_USERNAME', 'WP_APP_PASSWORD'];

// 每個 fetch 的逾時時間（毫秒）。
const FETCH_TIMEOUT_MS = 30 * 1000;

/**
 * 檢查某個環境變數是否已設定（存在且 trim 後非空字串）。
 * @param {string} name 環境變數名稱
 * @returns {boolean}
 */
function isEnvSet(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 回傳 REQUIRED_ENV_NAMES 中「未設定」的變數名稱陣列。
 * @returns {string[]}
 */
function missingEnv() {
  return REQUIRED_ENV_NAMES.filter((name) => !isEnvSet(name));
}

/**
 * 取得去除結尾斜線後的 WP_BASE_URL。
 * 呼叫前應已用 missingEnv() 確認環境變數齊全。
 * @returns {string}
 */
function getBaseUrl() {
  return process.env.WP_BASE_URL.trim().replace(/\/+$/, '');
}

/**
 * 組出 Basic Auth 的 Authorization header 值。
 * @returns {string}
 */
function getAuthHeader() {
  const username = process.env.WP_USERNAME.trim();
  const appPassword = process.env.WP_APP_PASSWORD.trim();
  const token = Buffer.from(`${username}:${appPassword}`, 'utf8').toString(
    'base64'
  );
  return `Basic ${token}`;
}

/**
 * 從 WordPress 錯誤回應的 body 中，盡量擷取出可讀的錯誤訊息摘要。
 * WP 錯誤通常是 JSON，格式如 { code, message, data }。
 * @param {string} bodyText 原始回應內容
 * @returns {string}
 */
function extractErrorMessage(bodyText) {
  if (!bodyText) return '（無回應內容）';

  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed.message === 'string' && parsed.message) {
      return parsed.message;
    }
  } catch (err) {
    // 非 JSON，直接使用原始文字。
  }

  // 避免錯誤訊息過長，截斷至 500 字。
  return bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
}

/**
 * 統一處理非 2xx 回應：讀出 body、組出清楚的中文錯誤並 throw。
 * @param {Response} response fetch 的回應物件
 * @returns {Promise<never>}
 */
async function throwForErrorResponse(response) {
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch (err) {
    // 讀取 body 失敗時，忽略，改用空字串。
  }

  const summary = extractErrorMessage(bodyText);
  let message = `WordPress 回應錯誤（HTTP ${response.status}）：${summary}`;

  if (response.status === 401 || response.status === 403) {
    message += '，請確認 WP_USERNAME 與 WP_APP_PASSWORD 是否正確';
  }

  throw new Error(message);
}

/**
 * 帶有 30 秒 timeout 的 fetch 包裝。逾時或連線失敗會 throw 清楚的中文錯誤。
 * @param {string} url
 * @param {import('node:http').RequestOptions & { body?: any, headers?: any, method?: string }} options
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('WordPress 連線逾時（超過 30 秒），請稍後再試');
    }
    throw new Error(`WordPress 連線失敗：${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 將檔名處理成可安全放進 Content-Disposition header 的形式。
 * 本專案檔名多為英數，這裡僅做基本防呆：移除雙引號與換行等會破壞 header 的字元。
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFilenameForHeader(filename) {
  const fallback = 'image.jpg';
  if (typeof filename !== 'string' || filename.trim() === '') {
    return fallback;
  }
  return filename.replace(/["\r\n]/g, '').trim() || fallback;
}

/**
 * 上傳圖片至 WordPress Media Library，並更新 caption 與 alt_text。
 * @param {{ buffer: Buffer, filename: string, contentType: string, caption?: string, altText?: string }} params
 * @returns {Promise<{ id: number, sourceUrl: string }>}
 */
async function uploadImage({ buffer, filename, contentType, caption, altText }) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(
      `WordPress 未設定（缺少 ${missing.join('、')}），無法上傳圖片`
    );
  }

  const baseUrl = getBaseUrl();
  const safeFilename = sanitizeFilenameForHeader(filename);

  const uploadResponse = await fetchWithTimeout(
    `${baseUrl}/wp-json/wp/v2/media`,
    {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'Content-Type': contentType,
      },
      body: buffer,
    }
  );

  if (!uploadResponse.ok) {
    await throwForErrorResponse(uploadResponse);
  }

  const media = await uploadResponse.json();
  const id = media.id;
  const sourceUrl = media.source_url;

  // 更新 caption 與 alt_text。此步驟失敗不影響上傳結果（圖片已成功上傳），只印警告。
  if (caption || altText) {
    try {
      const updateResponse = await fetchWithTimeout(
        `${baseUrl}/wp-json/wp/v2/media/${id}`,
        {
          method: 'POST',
          headers: {
            Authorization: getAuthHeader(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            caption: caption || '',
            alt_text: altText || '',
          }),
        }
      );

      if (!updateResponse.ok) {
        await throwForErrorResponse(updateResponse);
      }
    } catch (err) {
      console.warn(
        `WordPress 圖片（id: ${id}）已上傳成功，但更新 caption／alt_text 失敗：${
          err && err.message ? err.message : err
        }`
      );
    }
  }

  return { id, sourceUrl };
}

/**
 * 建立 WordPress 草稿文章。
 * 絕對不寫入任何 Elementor 相關 meta，一律 status: "draft"。
 * @param {{ title: string, html: string, featuredMediaId?: number|null }} params
 * @returns {Promise<{ id: number, link: string, editUrl: string }>}
 */
async function createDraft({ title, html, featuredMediaId }) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(
      `WordPress 未設定（缺少 ${missing.join('、')}），無法建立草稿`
    );
  }

  const baseUrl = getBaseUrl();

  const body = {
    title,
    content: html,
    status: 'draft',
  };

  if (featuredMediaId !== null && featuredMediaId !== undefined) {
    body.featured_media = featuredMediaId;
  }

  const response = await fetchWithTimeout(`${baseUrl}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwForErrorResponse(response);
  }

  const post = await response.json();
  const id = post.id;
  const link = post.link;
  const editUrl = `${baseUrl}/wp-admin/post.php?post=${id}&action=edit`;

  return { id, link, editUrl };
}

module.exports = {
  missingEnv,
  uploadImage,
  createDraft,
};
