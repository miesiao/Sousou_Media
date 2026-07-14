'use strict';

// 隅消息上稿系統 — Openverse 圖庫搜尋模組
// 規格第 5.3 節：以關鍵字搜尋 Openverse，回傳統一格式的候選圖陣列。
// Openverse 匿名即可使用，不需 API key。

const { randomUUID } = require('crypto');

// 單次 fetch 逾時時間(毫秒)。
const FETCH_TIMEOUT_MS = 20000;

// 每次搜尋取用的張數。
const PAGE_SIZE = 6;

// 保守過濾：只收這些授權類型，其餘（含 nc、nd）一律排除。
const ALLOWED_LICENSES = new Set(['cc0', 'by', 'by-sa']);

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
      throw new Error(`Openverse API 回應非 2xx（狀態碼 ${response.status}）`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 組出人類可讀的授權標籤，如 "CC BY-SA 4.0" 或 "CC0 1.0"。
 * cc0 為特殊情況：不重複加上 "CC" 前綴（避免變成 "CC CC0"）。
 * @param {string} license 小寫授權代碼，如 "by-sa"、"cc0"
 * @param {string} version 授權版本號，如 "4.0"
 * @returns {string}
 */
function formatLicenseLabel(license, version) {
  const safeVersion = typeof version === 'string' ? version.trim() : '';
  const lower = (license || '').toLowerCase();

  if (lower === 'cc0') {
    return safeVersion ? `CC0 ${safeVersion}` : 'CC0';
  }

  const upper = lower.toUpperCase();
  return safeVersion ? `CC ${upper} ${safeVersion}` : `CC ${upper}`;
}

/**
 * 以關鍵字搜尋 Openverse 圖庫，回傳統一格式的候選圖陣列。
 * 僅保留授權為 cc0 / by / by-sa 的結果，其餘（含 nc、nd）排除。
 * @param {string} keyword 搜尋關鍵字
 * @returns {Promise<object[]>} 候選圖陣列
 */
async function search(keyword) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(keyword)}&page_size=${PAGE_SIZE}&license_type=all-cc`;

  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];

  const candidates = [];

  for (const item of results) {
    const licenseRaw = (item.license || '').toLowerCase();
    if (!ALLOWED_LICENSES.has(licenseRaw)) {
      continue;
    }

    const creator = item.creator && String(item.creator).trim() !== '' ? item.creator : 'Unknown';
    const sourceName = item.source && String(item.source).trim() !== '' ? item.source : 'Openverse';
    const licenseLabel = formatLicenseLabel(licenseRaw, item.license_version);

    candidates.push({
      id: `openverse-${randomUUID()}`,
      source: 'openverse',
      thumbUrl: item.thumbnail || null,
      fullUrl: item.url || null,
      creator,
      sourcePageUrl: item.foreign_landing_url || null,
      license: licenseLabel,
      licenseUrl: item.license_url || null,
      attribution: `Photo: ${creator} / ${sourceName}(${licenseLabel})`,
      downloadLocation: null,
    });
  }

  return candidates;
}

module.exports = {
  search,
};
