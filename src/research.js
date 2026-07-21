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
const GEMINI_API_TIMEOUT_MS = 60000;

const SHEET_TAB_NAME = '候選題目';
const SHEET_HEADER = ['日期', '狀態', '題目', '摘要', '關鍵字', '參考連結'];
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
 * @returns {Array<{title: string, summary: string, keywords: string[], sourceUrl: string}>}
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
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const sourceUrl = typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim() : '';

    if (!title || !sourceUrl) {
      continue; // 沒標題或沒連結的候選不收(閘門用途，寧缺勿濫)
    }

    const keywords = Array.isArray(raw.keywords)
      ? raw.keywords
          .filter((kw) => typeof kw === 'string' && kw.trim() !== '')
          .map((kw) => kw.trim())
      : [];

    items.push({ title, summary, keywords, sourceUrl });
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
 * 確保「候選題目」分頁存在；不存在就建立並寫入表頭。
 * @param {import('googleapis').sheets_v4.Sheets} sheets
 * @returns {Promise<void>}
 */
async function ensureResearchTab(sheets) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: process.env.SHEET_ID,
  });

  const exists = (spreadsheet.data.sheets || []).some(
    (s) => s.properties && s.properties.title === SHEET_TAB_NAME
  );
  if (exists) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: SHEET_TAB_NAME } } }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${SHEET_TAB_NAME}!A1:F1`,
    valueInputOption: 'RAW',
    requestBody: { values: [SHEET_HEADER] },
  });
}

/**
 * 將候選清單各寫成一列，附加到「候選題目」分頁(狀態固定「待挑選」)。
 * @param {Array<{title: string, summary: string, keywords: string[], sourceUrl: string}>} items
 * @returns {Promise<void>}
 */
async function appendCandidates(items) {
  const sheets = getSheetsClient();
  await ensureResearchTab(sheets);

  const today = getTodayDash();
  const values = items.map((item) => [
    today,
    DEFAULT_STATUS,
    item.title,
    item.summary,
    item.keywords.join('、'),
    item.sourceUrl,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: `${SHEET_TAB_NAME}!A:F`,
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
