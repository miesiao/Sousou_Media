'use strict';

// 隅消息上稿系統 — Pexels 圖庫搜尋模組
// 規格第 5.1 節：以關鍵字搜尋 Pexels，回傳統一格式的候選圖陣列。

const { randomUUID } = require('crypto');

// 單次 fetch 逾時時間(毫秒)。
const FETCH_TIMEOUT_MS = 20000;

// 每次搜尋取用的張數。
const PER_PAGE = 6;

// 本系統一律以 Pexels License 標註（規格第 5.1 節）。
const LICENSE_NAME = 'Pexels License';
const LICENSE_URL = 'https://www.pexels.com/license/';

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
      throw new Error(`Pexels API 回應非 2xx（狀態碼 ${response.status}）`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 以關鍵字搜尋 Pexels 圖庫，回傳統一格式的候選圖陣列。
 * 缺少 PEXELS_API_KEY 時 throw 帶 code:'MISSING_ENV' 的 Error，由呼叫端轉為 skipped 狀態。
 * @param {string} keyword 搜尋關鍵字
 * @returns {Promise<object[]>} 候選圖陣列
 */
async function search(keyword) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    const err = new Error('Pexels 未設定（缺少 PEXELS_API_KEY），略過');
    err.code = 'MISSING_ENV';
    throw err;
  }

  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${PER_PAGE}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: apiKey.trim(),
    },
  });

  const data = await response.json();
  const photos = Array.isArray(data.photos) ? data.photos : [];

  return photos.map((photo) => {
    const src = photo.src || {};
    const fullUrl = src.large2x || src.original || src.large || src.medium || null;
    const photographer = photo.photographer || 'Unknown';

    return {
      id: `pexels-${randomUUID()}`,
      source: 'pexels',
      thumbUrl: src.medium || null,
      fullUrl,
      creator: photographer,
      sourcePageUrl: photo.url || null,
      license: LICENSE_NAME,
      licenseUrl: LICENSE_URL,
      attribution: `Photo: ${photographer} / Pexels`,
      downloadLocation: null,
    };
  });
}

module.exports = {
  search,
};
