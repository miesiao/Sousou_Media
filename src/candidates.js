'use strict';

// 隅消息上稿系統 — 候選題目讀取/狀態切換
// 讀寫對象是 src/research.js 寫入的「候選題目」分頁(研究段產出的候選清單)。
// 這裡只負責「列出候選」跟「切換狀態(待挑選 ↔ 已選)」，供上稿系統網頁介面選題用；
// 本身不呼叫 Gemini、不產生新候選。

const { google } = require('googleapis');
const { getAuthClient, missingAuthEnv } = require('./googleAuth');

const SHEET_TAB_NAME = '候選題目';
// 欄位順序需與 src/research.js 的 SHEET_HEADER 保持一致：
// A 日期 / B 狀態 / C 分類 / D 題目 / E 研究說明 / F 主要語言來源 / G 台灣人興趣觸發點 / H 參考資料
const DATA_RANGE = `${SHEET_TAB_NAME}!A2:H`;

const STATUS_PENDING = '待挑選';
const STATUS_SELECTED = '已選';

/**
 * 檢查讀寫候選題目所需的環境變數。
 * @returns {string[]}
 */
function missingEnv() {
  const missing = [];
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
 * 取得 Sheets API client(沿用 googleAuth.js 的共用認證)。
 * @returns {import('googleapis').sheets_v4.Sheets}
 */
function getSheetsClient() {
  const auth = getAuthClient();
  return google.sheets({ version: 'v4', auth });
}

/**
 * 讀取「候選題目」分頁全部候選(含 rowNumber，供更新狀態時定位列)。
 * 分頁尚未存在(研究段還沒執行過)時視為沒有候選，回傳空陣列而不是報錯。
 * @returns {Promise<Array<{rowNumber:number, date:string, status:string, category:string, title:string, research:string, sourceLanguages:string, taiwanHook:string, sourceUrls:string[]}>>}
 */
async function listCandidates() {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(`Google Sheets 未設定(缺少 ${missing.join('、')})`);
  }

  const sheets = getSheetsClient();

  let response;
  try {
    response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: DATA_RANGE,
    });
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (/Unable to parse range/i.test(message)) {
      return []; // 「候選題目」分頁還不存在：研究段尚未執行過
    }
    throw new Error(`讀取候選題目失敗：${message}`);
  }

  const rows = response.data.values || [];

  return rows
    .map((row, i) => {
      const rowNumber = i + 2; // A2 起算
      const [date, status, category, title, research, sourceLanguages, taiwanHook, sourceUrlsRaw] = row;

      if (!title || !String(title).trim()) {
        return null; // 跳過空列
      }

      const sourceUrls = String(sourceUrlsRaw || '')
        .split('\n')
        .map((url) => url.trim())
        .filter(Boolean);

      return {
        rowNumber,
        date: date || '',
        status: status || STATUS_PENDING,
        category: category || '',
        title,
        research: research || '',
        sourceLanguages: sourceLanguages || '',
        taiwanHook: taiwanHook || '',
        sourceUrls,
      };
    })
    .filter(Boolean);
}

/**
 * 更新單一候選列的「狀態」欄(B 欄)。
 * @param {number} rowNumber 試算表實際列號(從 2 起算)
 * @param {string} status 新狀態(STATUS_PENDING 或 STATUS_SELECTED)
 * @returns {Promise<void>}
 */
async function setCandidateStatus(rowNumber, status) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(`Google Sheets 未設定(缺少 ${missing.join('、')})`);
  }

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${SHEET_TAB_NAME}!B${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] },
  });
}

module.exports = {
  STATUS_PENDING,
  STATUS_SELECTED,
  missingEnv,
  listCandidates,
  setCandidateStatus,
};
