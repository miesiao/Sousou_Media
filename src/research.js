'use strict';

// 隅消息上稿系統 — 研究段
// 呼叫 Gemini API(含 Google 搜尋 grounding)找出「南方」相關新聞素材，寫入 Google Sheet
// 的「候選題目」分頁，狀態欄固定填「待挑選」。這一段不接撰寫，純粹產出候選讓人工挑選；
// 只有被人工把狀態改成「已選」的列，之後的撰寫段才會讀取(撰寫段尚未實作)。
//
// 可獨立執行：node src/research.js
// 想調整搜尋主題/則數/prompt 文字，請改 src/prompts/researchPrompt.js，不要改這裡。
// 想換 Gemini model 版本，改下面的 GEMINI_MODEL 常數。

require('dotenv').config();

const { google } = require('googleapis');
const { getAuthClient, missingAuthEnv } = require('./googleAuth');
const { buildResearchPrompt } = require('./prompts/researchPrompt');

// 想換新版 model，改這一行就好(用 ListModels API 現查過，2026-07-22 時 gemini-2.5-flash
// 已對新用戶下架，目前最新的正式版 Flash 是 gemini-3.6-flash)。
const GEMINI_MODEL = 'gemini-3.6-flash';
// 每則要求 300-500 字研究說明 + 跨多語言 grounding 搜尋，單次呼叫較久，故拉長到 3 分鐘。
const GEMINI_API_TIMEOUT_MS = 180000;

const SHEET_TAB_NAME = '候選題目';
const SHEET_HEADER = ['日期', '狀態', '分類', '題目', '研究說明', '主要語言來源', '台灣人興趣觸發點', '參考資料'];
const SHEET_RANGE = `${SHEET_TAB_NAME}!A:H`;
const DEFAULT_STATUS = '待挑選';

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
 * 呼叫 Gemini API(開啟 Google 搜尋 grounding)，回傳模型輸出的原始文字。
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_API_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      }),
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
    throw new Error('Gemini API 回應中找不到文字內容(可能被安全過濾攔截)');
  }

  return textPart.text;
}

/**
 * 解析 Gemini 回應文字為候選清單，過濾掉缺少標題或連結的項目。
 * @param {string} rawText
 * @returns {Array<{category: string, title: string, research: string, sourceLanguages: string, taiwanHook: string, sourceUrls: string[]}>}
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
    const category = typeof raw.category === 'string' ? raw.category.trim() : '';
    const research = typeof raw.research === 'string' ? raw.research.trim() : '';
    const sourceLanguages =
      typeof raw.sourceLanguages === 'string' ? raw.sourceLanguages.trim() : '';
    const taiwanHook = typeof raw.taiwanHook === 'string' ? raw.taiwanHook.trim() : '';

    const sourceUrls = Array.isArray(raw.sourceUrls)
      ? raw.sourceUrls
          .filter((url) => typeof url === 'string' && url.trim() !== '')
          .map((url) => url.trim())
      : [];

    if (!title || sourceUrls.length === 0) {
      continue; // 沒標題或沒連結的候選不收(閘門用途，寧缺勿濫)
    }

    items.push({ category, title, research, sourceLanguages, taiwanHook, sourceUrls });
  }

  return items;
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
 * 將候選清單各寫成一列，附加到「候選題目」分頁(狀態固定「待挑選」)。
 * @param {Array<{category: string, title: string, research: string, sourceLanguages: string, taiwanHook: string, sourceUrls: string[]}>} items
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
    item.sourceUrls.join('\n'),
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
 * 研究段主流程：呼叫 Gemini → 解析候選 → 寫入 Sheet。
 * @returns {Promise<void>}
 */
async function main() {
  const missing = missingEnv();
  if (missing.length > 0) {
    console.error(`[research] 無法執行，缺少環境變數：${missing.join('、')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[research] 呼叫 Gemini(${GEMINI_MODEL})搜尋候選題目...`);
  const rawText = await callGemini(buildResearchPrompt());

  const items = parseCandidates(rawText);
  if (items.length === 0) {
    console.error('[research] 沒有解析出任何有效候選，原始回應如下：');
    console.error(rawText);
    process.exitCode = 1;
    return;
  }

  console.log(`[research] 解析出 ${items.length} 則候選，寫入 Sheet「${SHEET_TAB_NAME}」分頁...`);
  await appendCandidates(items);
  console.log(`[research] 完成，已寫入 ${items.length} 則候選(狀態：${DEFAULT_STATUS})`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[research] 執行失敗：', err && err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  missingEnv,
  parseCandidates,
  appendCandidates,
  main,
};
