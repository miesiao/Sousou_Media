'use strict';

// 隅消息上稿系統 — 圖源搜尋總入口
// 規格第 5.5 節：對每組關鍵字 × 每個來源並行搜尋（Promise.allSettled，互不影響），
// 合併結果、依 fullUrl 去重、以來源 round-robin 截斷至最多 36 張，
// 並回報每個來源的狀態（ok / skipped / error）。

const pexels = require('./pexels');
const unsplash = require('./unsplash');
const openverse = require('./openverse');
const wikimedia = require('./wikimedia');

// 四個來源，固定順序（也是 round-robin 截斷時使用的順序）。
const SOURCE_ORDER = ['pexels', 'unsplash', 'openverse', 'wikimedia'];

const SOURCE_MODULES = {
  pexels,
  unsplash,
  openverse,
  wikimedia,
};

// 每組關鍵字每個來源最多取用的張數（各來源模組內部已各自限制為 6）。
// 全部來源合併去重後的總數上限。
const MAX_TOTAL_CANDIDATES = 36;

/**
 * 將 Error 物件簡化成一句簡短訊息（HTTP 狀態碼或錯誤訊息本身）。
 * @param {Error} err
 * @returns {string}
 */
function summarizeError(err) {
  if (!err) {
    return '未知錯誤';
  }
  return err.message || String(err);
}

/**
 * 針對單一來源，執行「每組關鍵字都搜尋一次」，並回傳原始（未去重、未截斷）候選圖佇列，
 * 以及該來源的初步狀態（skipped / error / ok，count 尚未反映最終進入結果的張數）。
 * @param {string} sourceName 來源名稱
 * @param {string[]} keywords 關鍵字陣列
 * @returns {Promise<{ sourceName: string, rawCandidates: object[], status: string, message: string }>}
 */
async function runSourceSearch(sourceName, keywords) {
  const module = SOURCE_MODULES[sourceName];

  const settled = await Promise.allSettled(
    keywords.map((keyword) => module.search(keyword))
  );

  // 缺少 API key：來源模組在每次呼叫開頭就會 throw MISSING_ENV，
  // 因此只要出現一次就代表整個來源都要略過。
  const missingEnvResult = settled.find(
    (r) => r.status === 'rejected' && r.reason && r.reason.code === 'MISSING_ENV'
  );

  if (missingEnvResult) {
    return {
      sourceName,
      rawCandidates: [],
      status: 'skipped',
      message: summarizeError(missingEnvResult.reason),
    };
  }

  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  const rejected = settled.filter((r) => r.status === 'rejected');

  if (fulfilled.length === 0 && rejected.length > 0) {
    return {
      sourceName,
      rawCandidates: [],
      status: 'error',
      message: `${sourceName} 搜尋全部失敗（${summarizeError(rejected[0].reason)}）`,
    };
  }

  const rawCandidates = fulfilled.flatMap((r) => (Array.isArray(r.value) ? r.value : []));

  return {
    sourceName,
    rawCandidates,
    status: 'ok',
    message: '',
  };
}

/**
 * 依 fullUrl 去重，並以「來源 round-robin」方式截斷至最多 MAX_TOTAL_CANDIDATES 張，
 * 盡量讓每個有結果的來源都有代表。
 * @param {Record<string, object[]>} candidatesBySource 各來源的原始候選圖佇列（僅限 status 為 ok 的來源）
 * @returns {{ finalCandidates: object[], countBySource: Record<string, number> }}
 */
function mergeRoundRobin(candidatesBySource) {
  const cursors = {};
  for (const name of SOURCE_ORDER) {
    cursors[name] = 0;
  }

  const seenFullUrls = new Set();
  const finalCandidates = [];
  const countBySource = {};
  for (const name of SOURCE_ORDER) {
    countBySource[name] = 0;
  }

  let anyRemaining = true;
  while (finalCandidates.length < MAX_TOTAL_CANDIDATES && anyRemaining) {
    anyRemaining = false;

    for (const name of SOURCE_ORDER) {
      if (finalCandidates.length >= MAX_TOTAL_CANDIDATES) {
        break;
      }

      const queue = candidatesBySource[name] || [];

      // 跳過重複的 fullUrl，直到找到一張未出現過的圖，或該來源佇列耗盡。
      while (cursors[name] < queue.length) {
        const candidate = queue[cursors[name]];
        cursors[name] += 1;

        const dedupeKey = candidate.fullUrl || candidate.id;
        if (seenFullUrls.has(dedupeKey)) {
          continue;
        }

        seenFullUrls.add(dedupeKey);
        finalCandidates.push(candidate);
        countBySource[name] += 1;
        anyRemaining = true;
        break;
      }

      if (cursors[name] < queue.length) {
        anyRemaining = true;
      }
    }
  }

  return { finalCandidates, countBySource };
}

/**
 * 對每組關鍵字，同時向四個圖源（Pexels / Unsplash / Openverse / Wikimedia Commons）搜尋，
 * 合併、去重、截斷後回傳候選圖陣列，並附上每個來源的搜尋狀態。
 * @param {string[]} keywords 搜尋關鍵字陣列（例如關鍵字抽取模組輸出的 2–3 組）
 * @returns {Promise<{ candidates: object[], sourceStatus: Record<string, { status: string, count: number, message: string }> }>}
 */
async function searchAllSources(keywords) {
  const safeKeywords = Array.isArray(keywords)
    ? keywords.filter((kw) => typeof kw === 'string' && kw.trim() !== '')
    : [];

  const sourceResults = await Promise.all(
    SOURCE_ORDER.map((name) => runSourceSearch(name, safeKeywords))
  );

  const candidatesBySource = {};
  const sourceStatus = {};

  for (const result of sourceResults) {
    candidatesBySource[result.sourceName] = result.status === 'ok' ? result.rawCandidates : [];
    sourceStatus[result.sourceName] = {
      status: result.status,
      count: 0,
      message: result.message,
    };
  }

  const { finalCandidates, countBySource } = mergeRoundRobin(candidatesBySource);

  for (const name of SOURCE_ORDER) {
    if (sourceStatus[name].status === 'ok') {
      sourceStatus[name].count = countBySource[name];
      if (countBySource[name] === 0) {
        sourceStatus[name].message = '本次無結果';
      }
    }
  }

  return {
    candidates: finalCandidates,
    sourceStatus,
  };
}

module.exports = {
  searchAllSources,
  triggerDownload: unsplash.triggerDownload,
  MAX_TOTAL_CANDIDATES,
};
