'use strict';

// 隅消息上稿系統 — 研究段
// 呼叫 Gemini API(含 Google 搜尋 grounding)找出「南方」相關新聞素材，寫入 Google Sheet
// 的「候選題目」分頁，狀態欄固定填「未決」。這一段不接撰寫，純粹產出候選讓人工挑選；
// 只有被人工把狀態改成「已選」的列，之後的撰寫段才會讀取(撰寫段尚未實作)。
//
// 可獨立執行(排程用，固定產出 CANDIDATE_COUNT 則)：node src/research.js
// 網頁「再搜 N 則」按鈕跟手動新增則呼叫本檔匯出的 generateCandidates() / appendManualCandidate()。
// 想調整搜尋主題/字數/prompt 文字，請改 src/prompts/researchPrompt.js，不要改這裡。
// 想換 Gemini model 版本，改下面的 GEMINI_MODEL 常數。

require('dotenv').config();

const { google } = require('googleapis');
const { getAuthClient, missingAuthEnv } = require('./googleAuth');
const { buildResearchPrompt, buildExtractionPrompt, CANDIDATE_COUNT } = require('./prompts/researchPrompt');
const { STATUS_PENDING, STATUS_WRITE, buildDedupTitleList } = require('./candidates');
const {
  extractGroundingSources,
  resolveAllRedirects,
  hostnameFromUrl,
  mediaMatchesSource,
  formatSourceLine,
  buildMediaMatchText,
  buildFallbackText,
  buildContentMatchPrompt,
  parseContentMatchResponse,
} = require('./grounding');

// 想換新版 model，改這一行就好(用 ListModels API 現查過，2026-07-22 時 gemini-2.5-flash
// 已對新用戶下架，目前最新的正式版 Flash 是 gemini-3.6-flash)。
const GEMINI_MODEL = 'gemini-3.6-flash';
// 每則要求 300-500 字研究說明 + 跨多語言 grounding 搜尋，單次呼叫較久，故拉長到 3 分鐘。
const GEMINI_API_TIMEOUT_MS = 180000;

// 內容比對用的輕量 model(不開搜尋工具，只是把來源分配給候選，不需要用主力 model)。
// 用 ListModels API 現查過，2026-07-23 時最新的正式版 flash-lite 是 gemini-3.5-flash-lite。
const CONTENT_MATCH_MODEL = 'gemini-3.5-flash-lite';
// 獨立於主要研究呼叫的 timeout；這一步失敗要能快速判定退回媒體名稱比對，不拖累整體流程。
const CONTENT_MATCH_TIMEOUT_MS = 30000;

const SHEET_TAB_NAME = '候選題目';
const SHEET_HEADER = ['日期', '狀態', '分類', '題目', '研究說明', '主要語言來源', '台灣人興趣觸發點', '參考資料'];
const SHEET_RANGE = `${SHEET_TAB_NAME}!A:H`;
const DEFAULT_STATUS = STATUS_PENDING;

/**
 * 檢查研究段所需的環境變數。
 * @returns {string[]}
 */
function missingEnv() {
  const missing = [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    missing.push('GEMINI_API_KEY');
  }
  if (missingAuthEnv().length > 0) {
    missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  const sheetId = process.env.SHEET_ID;
  if (typeof sheetId !== 'string' || sheetId.trim() === '') {
    missing.push('SHEET_ID');
  }

  return missing;
}

/**
 * 取得台灣(Asia/Taipei)當前日期字串(YYYY-MM-DD)。
 * @returns {string}
 */
function getTodayDash() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * 移除模型回應中可能包在外層的 ```json ... ``` 或 ``` ... ``` code fence。
 * @param {string} text
 * @returns {string}
 */
function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * 呼叫 Gemini API 的底層 helper。
 *
 * 重要(實測得出，別再改回單一 prompt 硬凹)：Gemini 只要 prompt 要求「只回傳 JSON、
 * 不要有任何說明文字」，就完全不會觸發 Google 搜尋 grounding(groundingMetadata 整個消失，
 * 模型改成純憑訓練記憶編造內容)；而且 API 本身也不允許 tools(google_search) 跟
 * generationConfig.responseMimeType=application/json 同時使用(會直接回傳空結果)。
 * 所以「真的搜尋」跟「乾淨 JSON 輸出」不能在同一次呼叫裡兼得，一定要拆成兩次呼叫：
 * useSearchTool:true 的自然語言研究呼叫，跟 useSearchTool:false 的純格式轉換呼叫。
 * @param {string} prompt
 * @param {boolean} useSearchTool 是否開啟 google_search 工具
 * @param {{model?: string, timeoutMs?: number}} [options] model/timeout 覆寫(給內容比對用不同 model 跟獨立 timeout)
 * @returns {Promise<{text: string, groundingMetadata: object|null}>}
 */
async function callGeminiGenerateContent(prompt, useSearchTool, options) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = (options && options.model) || GEMINI_MODEL;
  const timeoutMs = (options && options.timeoutMs) || GEMINI_API_TIMEOUT_MS;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (useSearchTool) {
    requestBody.tools = [{ google_search: {} }];
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Gemini API 回應狀態碼 ${response.status}：${detail.slice(0, 500)}`
    );
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const textPart = Array.isArray(parts)
    ? parts.find((p) => typeof p.text === 'string')
    : null;

  if (!textPart) {
    throw new Error('Gemini API 回應中找不到文字內容(可能被安全過濾攔截，或沒有產生任何候選)');
  }

  const groundingMetadata = (candidate && candidate.groundingMetadata) || null;

  return { text: textPart.text, groundingMetadata };
}

/**
 * 第一段：自然語言研究呼叫(開 Google 搜尋 grounding)。
 * groundingMetadata 是後續解析真實參考連結的唯一依據——模型輸出文字裡的任何網址都可能是
 * 憑印象編造的，絕對不能直接採信，一定要從 groundingMetadata.groundingChunks 取得。
 * @param {string} prompt
 * @returns {Promise<{text: string, groundingMetadata: object|null}>}
 */
async function researchWithGrounding(prompt) {
  return callGeminiGenerateContent(prompt, true);
}

/**
 * 第二段：把第一段的自然語言報告轉成結構化 JSON 文字(不開搜尋工具)。
 * @param {string} reportText
 * @returns {Promise<string>}
 */
async function extractCandidatesJson(reportText) {
  const { text } = await callGeminiGenerateContent(buildExtractionPrompt(reportText), false);
  return text;
}

/**
 * 用一次輕量 Gemini 呼叫，依內容相關性把每個 grounding 來源分配給正確的候選(跨語言比對)。
 * 這一步失敗(逾時/API 錯誤/回應格式不對)不可讓整體流程中斷——直接回傳空 Map，
 * 呼叫端會整批退回媒體名稱比對，等同於這一步從沒發生過。
 * @param {Array<{title: string, research: string, taiwanHook: string}>} items
 * @param {Array<object>} enrichedSources
 * @returns {Promise<Map<number, number>>} sourceIndex → candidateIndex
 */
async function matchSourcesToCandidatesByContent(items, enrichedSources) {
  if (enrichedSources.length === 0) {
    return new Map();
  }

  try {
    const prompt = buildContentMatchPrompt(items, enrichedSources);
    const { text } = await callGeminiGenerateContent(prompt, false, {
      model: CONTENT_MATCH_MODEL,
      timeoutMs: CONTENT_MATCH_TIMEOUT_MS,
    });
    return parseContentMatchResponse(text, enrichedSources.length, items.length);
  } catch (err) {
    console.warn(
      `[research] 內容比對呼叫失敗，退回媒體名稱比對(${err && err.message})`
    );
    return new Map();
  }
}

/**
 * 解析 Gemini 回應文字為候選清單，只過濾掉缺少標題的項目。
 * 注意：不再要求 sourceMedia 非空才收——連結/來源比對是後續 attachReferenceText()
 * 的工作，這裡的閘門只確保「至少有題目可看」，避免因為模型沒填媒體名稱就整批漏掉好題目。
 * @param {string} rawText
 * @returns {Array<{category: string, title: string, research: string, sourceLanguages: string, taiwanHook: string, sourceMedia: string[]}>}
 */
function parseCandidates(rawText) {
  const cleaned = stripCodeFence(rawText);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('Gemini 回應無法解析為 JSON：' + (err && err.message));
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini 回應格式不是陣列');
  }

  const items = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) continue; // 唯一的收錄閘門：至少要有標題

    const category = typeof raw.category === 'string' ? raw.category.trim() : '';
    const research = typeof raw.research === 'string' ? raw.research.trim() : '';
    const sourceLanguages =
      typeof raw.sourceLanguages === 'string' ? raw.sourceLanguages.trim() : '';
    const taiwanHook = typeof raw.taiwanHook === 'string' ? raw.taiwanHook.trim() : '';

    const sourceMedia = Array.isArray(raw.sourceMedia)
      ? raw.sourceMedia
          .filter((media) => typeof media === 'string' && media.trim() !== '')
          .map((media) => media.trim())
      : [];

    items.push({ category, title, research, sourceLanguages, taiwanHook, sourceMedia });
  }

  return items;
}

/**
 * 用 grounding 來源解出每則候選的「參考資料」文字，附加到各候選物件上(referenceText 欄位)。
 *
 * 比對層級(由高到低，每則候選採用第一個「有結果」的層級)：
 * 1. 內容比對：一次 Gemini 呼叫，依文章標題跟候選主題的相關性判斷歸屬(跨語言)。
 *    這裡「認領」到的來源會從其他候選的比對池中移除，避免同一媒體的兩篇不同報導
 *    被兩個不相干的候選同時當作自己的來源(實測發生過的錯配案例)。
 * 2. 媒體名稱比對：在「尚未被內容比對認領」的來源裡，用 sourceMedia 寬鬆比對；
 *    同一媒體名同時比對到 2 筆以上來源時，標記為不確定，不悄悄照單全收。
 * 3. 備援清單：都比對不到時，列出「尚未被認領」的來源(最多幾筆)供人工查證起點，
 *    不因此丟棄候選，但也不會把整批來源塞進每一則備援(見 grounding.js 的 MAX_FALLBACK_SOURCES)。
 *
 * @param {Array<{title: string, research: string, taiwanHook: string, sourceMedia: string[]}>} items
 * @param {object|null} groundingMetadata
 * @returns {Promise<Array<object>>} 每個 item 多一個 referenceText 欄位
 */
async function attachReferenceText(items, groundingMetadata) {
  const sources = extractGroundingSources(groundingMetadata);
  const resolvedInfos = await resolveAllRedirects(sources);

  const enrichedSources = sources.map((source, i) => {
    const info = resolvedInfos[i] || {};
    const resolvedUri = info.resolvedUri || source.uri;
    return {
      ...source,
      resolvedUri,
      pageTitle: info.pageTitle || null,
      hostname: hostnameFromUrl(resolvedUri),
    };
  });

  const contentMatches = await matchSourcesToCandidatesByContent(items, enrichedSources);

  // 內容比對「認領」到的來源，其他候選的媒體名稱比對不能再拿去用，
  // 避免同一媒體的兩篇不同報導被兩個不相干的候選同時當作自己的來源。
  const claimedSourceIndices = new Set(contentMatches.keys());

  return items.map((item, itemIndex) => {
    const ownContentSources = enrichedSources.filter(
      (_, sourceIndex) => contentMatches.get(sourceIndex) === itemIndex
    );

    let referenceText;
    if (ownContentSources.length > 0) {
      referenceText = ownContentSources
        .map((source) => {
          const label = item.sourceMedia.find((m) => mediaMatchesSource(m, source));
          return formatSourceLine(source, label);
        })
        .join('\n');
    } else {
      const availableSources = enrichedSources.filter(
        (_, sourceIndex) => !claimedSourceIndices.has(sourceIndex)
      );
      const mediaText = buildMediaMatchText(item, availableSources);
      referenceText = mediaText !== null ? mediaText : buildFallbackText(item, availableSources);
    }

    return { ...item, referenceText };
  });
}

/**
 * 取得 Sheets API client(沿用 googleAuth.js 的共用認證)。
 * @returns {import('googleapis').sheets_v4.Sheets}
 */
function getSheetsClient() {
  const auth = getAuthClient();
  return google.sheets({ version: 'v4', auth });
}

/**
 * 確保「候選題目」分頁存在，且第一列是正確的表頭。
 * - 分頁不存在：建立分頁 + 直接寫入表頭。
 * - 分頁存在但第一列是空的(例如剛被清空)：直接寫入表頭。
 * - 分頁存在但第一列已經是資料(表頭遺失，例如曾被清空值但沒補表頭)：
 *   先在最上面插入一列(既有資料整體下移，不覆蓋)，再寫入表頭。
 * 這裡不能只檢查「分頁存不存在」就跳過，否則表頭遺失時 listCandidates() 的
 * A2:H 會把第一筆真實候選誤判成表頭、少讀一筆。
 * @param {import('googleapis').sheets_v4.Sheets} sheets
 * @returns {Promise<void>}
 */
async function ensureResearchTab(sheets) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: process.env.SHEET_ID,
  });

  const sheetMeta = (spreadsheet.data.sheets || []).find(
    (s) => s.properties && s.properties.title === SHEET_TAB_NAME
  );

  if (!sheetMeta) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_TAB_NAME } } }],
      },
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `${SHEET_TAB_NAME}!A1:H1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADER] },
    });
    return;
  }

  const headerRow = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${SHEET_TAB_NAME}!A1:H1`,
  });
  const currentFirstRow = (headerRow.data.values && headerRow.data.values[0]) || [];

  const headerMatches = SHEET_HEADER.every((col, i) => currentFirstRow[i] === col);
  if (headerMatches) {
    return;
  }

  const firstRowHasContent = currentFirstRow.some(
    (cell) => cell !== '' && cell !== undefined && cell !== null
  );

  if (firstRowHasContent) {
    // 第一列已經有內容但不是表頭：先插入一列把既有資料整體下移，避免覆蓋掉真實候選。
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SHEET_ID,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId: sheetMeta.properties.sheetId,
                dimension: 'ROWS',
                startIndex: 0,
                endIndex: 1,
              },
            },
          },
        ],
      },
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${SHEET_TAB_NAME}!A1:H1`,
    valueInputOption: 'RAW',
    requestBody: { values: [SHEET_HEADER] },
  });
}

/**
 * 將候選清單各寫成一列，附加到「候選題目」分頁(狀態固定「未決」)。
 * @param {Array<{category: string, title: string, research: string, sourceLanguages: string, taiwanHook: string, referenceText: string}>} items
 * @returns {Promise<void>}
 */
async function appendCandidates(items) {
  const sheets = getSheetsClient();
  await ensureResearchTab(sheets);

  const today = getTodayDash();
  const values = items.map((item) => [
    today,
    DEFAULT_STATUS,
    item.category,
    item.title,
    item.research,
    item.sourceLanguages,
    item.taiwanHook,
    item.referenceText || '',
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

/**
 * 研究段核心流程：算去重清單 → 自然語言研究(觸發搜尋) → 轉 JSON → 解析候選
 * → 解析 grounding 來源 → 寫入 Sheet。排程(main())跟「再搜 N 則」網頁按鈕共用這個函式，
 * 差別只在要求的候選則數。
 * @param {number} count 要求產出的候選則數
 * @returns {Promise<Array<object>>} 已寫入 Sheet 的候選清單
 */
async function generateCandidates(count) {
  console.log('[research] 讀取既有候選以組出去重清單...');
  const dedupTitles = await buildDedupTitleList();

  console.log(`[research] 呼叫 Gemini(${GEMINI_MODEL})進行研究(開啟 Google 搜尋)...`);
  const { text: reportText, groundingMetadata } = await researchWithGrounding(
    buildResearchPrompt(count, dedupTitles)
  );

  console.log(`[research] 呼叫 Gemini(${GEMINI_MODEL})將研究報告轉成結構化 JSON...`);
  const rawText = await extractCandidatesJson(reportText);

  const items = parseCandidates(rawText);
  if (items.length === 0) {
    throw new Error(`沒有解析出任何有效候選，原始回應：${rawText.slice(0, 500)}`);
  }

  console.log(`[research] 解析出 ${items.length} 則候選，解析 grounding 來源連結...`);
  const itemsWithReferences = await attachReferenceText(items, groundingMetadata);

  console.log(`[research] 寫入 Sheet「${SHEET_TAB_NAME}」分頁...`);
  await appendCandidates(itemsWithReferences);
  console.log(`[research] 完成，已寫入 ${itemsWithReferences.length} 則候選(狀態：${DEFAULT_STATUS})`);

  return itemsWithReferences;
}

/**
 * 手動新增單一候選(走跟自動產出完全相同的 Sheet 寫入流程)。
 * 前面已經由 src/candidateParser.js 的 AI 解析 + 人工在預覽表單確認/修改過，
 * 這裡只負責照固定欄位順序寫入一列。狀態固定「已選」、日期填當天；不新增欄位，
 * 研究說明欄前綴「【手動新增】」以便辨識來源。
 * @param {{title: string, category?: string, research?: string, sourceLanguages?: string, taiwanHook?: string, referenceText?: string}} input
 * @returns {Promise<void>}
 */
async function appendManualCandidate(input) {
  const title = (input && input.title) || '';
  const category = (input && input.category) || '';
  const research = (input && input.research) || '';
  const sourceLanguages = (input && input.sourceLanguages) || '';
  const taiwanHook = (input && input.taiwanHook) || '';
  const referenceText = (input && input.referenceText) || '';

  const sheets = getSheetsClient();
  await ensureResearchTab(sheets);

  const today = getTodayDash();
  const researchWithTag = research ? `【手動新增】${research}` : '【手動新增】';

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[today, STATUS_WRITE, category, title, researchWithTag, sourceLanguages, taiwanHook, referenceText]],
    },
  });
}

/**
 * 研究段獨立執行入口(node src/research.js / 排程)：固定產出 CANDIDATE_COUNT 則。
 * @returns {Promise<void>}
 */
async function main() {
  const missing = missingEnv();
  if (missing.length > 0) {
    console.error(`[research] 無法執行，缺少環境變數：${missing.join('、')}`);
    process.exitCode = 1;
    return;
  }

  await generateCandidates(CANDIDATE_COUNT);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[research] 執行失敗：', err && err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  missingEnv,
  researchWithGrounding,
  extractCandidatesJson,
  parseCandidates,
  attachReferenceText,
  appendCandidates,
  generateCandidates,
  appendManualCandidate,
  main,
};
