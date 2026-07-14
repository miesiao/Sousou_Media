'use strict';

// 隅消息上稿系統 — Wikimedia Commons 搜尋模組
// 規格第 5.4 節：以關鍵字搜尋 Wikimedia Commons，搜尋與中繼資料（含授權）一次取得，
// 回傳統一格式的候選圖陣列。不需要 API key，但必須設定有意義的 User-Agent。

const { randomUUID } = require('crypto');

// 單次 fetch 逾時時間(毫秒)。
const FETCH_TIMEOUT_MS = 20000;

// 每次搜尋取用的張數。
const SEARCH_LIMIT = 6;

// 縮圖寬度。
const THUMB_WIDTH = 400;

// Wikimedia API 要求呼叫端提供有意義的 User-Agent。
const USER_AGENT = 'sousoucorner-publisher/1.0 (https://sousoucorner.org)';

// 只收這些副檔名（點陣圖），排除 pdf/svg/tif/tiff/djvu/webm/ogg 等非點陣圖格式。
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

/**
 * 帶逾時控制的 fetch。逾時或網路錯誤會 throw，非 2xx 回應也會 throw（含狀態碼）。
 * @param {string} url
 * @param {object} options fetch 選項（不含 signal，由本函式加上）
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Wikimedia Commons API 回應非 2xx（狀態碼 ${response.status}）`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 簡單 strip HTML tags，並 trim 頭尾空白。extmetadata.Artist.value 常帶有 <a> 等標籤。
 * @param {string} html
 * @returns {string}
 */
function stripHtmlTags(html) {
  if (typeof html !== 'string') {
    return '';
  }
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * 從 URL 取出小寫副檔名（不含點），取不到時回傳空字串。
 * @param {string} url
 * @returns {string}
 */
function getExtension(url) {
  if (typeof url !== 'string') {
    return '';
  }
  const withoutQuery = url.split('?')[0];
  const match = withoutQuery.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

/**
 * 以關鍵字搜尋 Wikimedia Commons，回傳統一格式的候選圖陣列。
 * 排除非點陣圖檔案，以及 LicenseShortName 為空或含 "Fair use" 的結果。
 * @param {string} keyword 搜尋關鍵字
 * @returns {Promise<object[]>} 候選圖陣列
 */
async function search(keyword) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: keyword,
    gsrnamespace: '6',
    gsrlimit: String(SEARCH_LIMIT),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: String(THUMB_WIDTH),
    format: 'json',
  });

  const url = `https://commons.wikimedia.org/w/api.php?${params.toString()}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  });

  const data = await response.json();
  const pagesObj = data && data.query && data.query.pages ? data.query.pages : null;

  // 無結果時 query.pages 可能不存在，防呆回傳空陣列。
  if (!pagesObj || typeof pagesObj !== 'object') {
    return [];
  }

  const pages = Object.values(pagesObj);
  const candidates = [];

  for (const page of pages) {
    const imageinfo = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
    if (!imageinfo) {
      continue;
    }

    const fullUrl = imageinfo.url || null;
    const extension = getExtension(fullUrl) || getExtension(page.title);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      continue;
    }

    const extmetadata = imageinfo.extmetadata || {};
    const licenseShortName =
      extmetadata.LicenseShortName && typeof extmetadata.LicenseShortName.value === 'string'
        ? extmetadata.LicenseShortName.value.trim()
        : '';

    if (licenseShortName === '' || /fair use/i.test(licenseShortName)) {
      continue;
    }

    const artistRaw =
      extmetadata.Artist && typeof extmetadata.Artist.value === 'string' ? extmetadata.Artist.value : '';
    const creator = stripHtmlTags(artistRaw) || 'Unknown';

    const licenseUrl =
      extmetadata.LicenseUrl && typeof extmetadata.LicenseUrl.value === 'string'
        ? extmetadata.LicenseUrl.value
        : null;

    candidates.push({
      id: `wikimedia-${randomUUID()}`,
      source: 'wikimedia',
      thumbUrl: imageinfo.thumburl || null,
      fullUrl,
      creator,
      sourcePageUrl: imageinfo.descriptionurl || null,
      license: licenseShortName,
      licenseUrl,
      attribution: `Photo: ${creator} / Wikimedia Commons (${licenseShortName})`,
      downloadLocation: null,
    });
  }

  return candidates;
}

module.exports = {
  search,
};
