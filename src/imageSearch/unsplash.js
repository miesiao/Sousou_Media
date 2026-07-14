'use strict';

// 隅消息上稿系統 — Unsplash 圖庫搜尋模組
// 規格第 5.2 節：以關鍵字搜尋 Unsplash，回傳統一格式的候選圖陣列。

const { randomUUID } = require('crypto');

// 單次 fetch 逾時時間(毫秒)。
const FETCH_TIMEOUT_MS = 20000;

// 每次搜尋取用的張數。
const PER_PAGE = 6;

const LICENSE_NAME = 'Unsplash License';
const LICENSE_URL = 'https://unsplash.com/license';

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
      throw new Error(`Unsplash API 回應非 2xx（狀態碼 ${response.status}）`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 以關鍵字搜尋 Unsplash 圖庫，回傳統一格式的候選圖陣列。
 * 缺少 UNSPLASH_ACCESS_KEY 時 throw 帶 code:'MISSING_ENV' 的 Error，由呼叫端轉為 skipped 狀態。
 * @param {string} keyword 搜尋關鍵字
 * @returns {Promise<object[]>} 候選圖陣列
 */
async function search(keyword) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (typeof accessKey !== 'string' || accessKey.trim() === '') {
    const err = new Error('Unsplash 未設定（缺少 UNSPLASH_ACCESS_KEY），略過');
    err.code = 'MISSING_ENV';
    throw err;
  }

  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(keyword)}&per_page=${PER_PAGE}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Client-ID ${accessKey.trim()}`,
    },
  });

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return results.map((photo) => {
    const urls = photo.urls || {};
    const user = photo.user || {};
    const links = photo.links || {};
    const creatorName = user.name || 'Unknown';

    return {
      id: `unsplash-${randomUUID()}`,
      source: 'unsplash',
      thumbUrl: urls.small || null,
      fullUrl: urls.regular || null,
      creator: creatorName,
      sourcePageUrl: links.html || null,
      license: LICENSE_NAME,
      licenseUrl: LICENSE_URL,
      attribution: `Photo: ${creatorName} / Unsplash`,
      downloadLocation: links.download_location || null,
    };
  });
}

/**
 * 依 Unsplash API 條款：實際選用某張圖時，必須對其 download_location 觸發一次 GET
 * 以計數下載次數。任何失敗（含缺少 UNSPLASH_ACCESS_KEY）只 console.warn，不 throw、
 * 不中斷主流程（規格第 9 節）。
 * @param {string} downloadLocation 候選圖物件的 downloadLocation 欄位
 * @returns {Promise<void>}
 */
async function triggerDownload(downloadLocation) {
  if (typeof downloadLocation !== 'string' || downloadLocation.trim() === '') {
    console.warn('Unsplash 下載計數略過：downloadLocation 為空');
    return;
  }

  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (typeof accessKey !== 'string' || accessKey.trim() === '') {
    console.warn('Unsplash 下載計數略過：缺少 UNSPLASH_ACCESS_KEY');
    return;
  }

  try {
    await fetchWithTimeout(downloadLocation, {
      headers: {
        Authorization: `Client-ID ${accessKey.trim()}`,
      },
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    console.warn(`Unsplash 下載計數觸發失敗（${detail}）`);
  }
}

module.exports = {
  search,
  triggerDownload,
};
