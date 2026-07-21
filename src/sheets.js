'use strict';

// 隅消息上稿系統 — Google Sheets 整合
// 試算表欄位 A–D：編號、日期、上稿狀態、題目。編號由目前試算表最大編號 + 1 決定，
// 上稿狀態固定寫「草稿」。

const { google } = require('googleapis');
const { missingAuthEnv, getAuthClient } = require('./googleAuth');

// 單一 API 呼叫的 timeout（毫秒）。
const API_TIMEOUT_MS = 30000;

/**
 * 檢查寫入試算表所需的環境變數。
 * @returns {string[]} 缺少的環境變數名稱陣列
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
 * 取得 Sheets API client。
 * @returns {import('googleapis').sheets_v4.Sheets}
 */
function getSheetsClient() {
  const auth = getAuthClient();
  return google.sheets({ version: 'v4', auth });
}

/**
 * 將 Google API 的錯誤包裝成清楚的中文錯誤訊息。
 * @param {unknown} err 原始錯誤
 * @param {string} action 動作描述（用於錯誤訊息開頭）
 * @returns {Error}
 */
function wrapApiError(err, action) {
  const status = err && (err.code || (err.response && err.response.status));
  const summary = (err && err.message) || String(err);

  let hint = '';
  if (status === 403 || status === 404) {
    hint =
      '請確認試算表已分享給 Service Account 的 email（編輯權限）且 ID 正確';
  }

  const statusText = status ? `HTTP ${status}` : '未知狀態';
  return new Error(
    `${action}失敗（${statusText}）：${summary}${hint ? '，' + hint : ''}`
  );
}

/**
 * 讀取欄位 A（編號）目前最大值，回傳下一個可用編號（最大值 + 1；試算表無資料列時回傳 1）。
 * @returns {Promise<number>}
 */
async function getNextArticleNumber() {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(
      `Google Sheets 未設定（缺少 ${missing.join('、')}），無法取得文章編號`
    );
  }

  const sheets = getSheetsClient();

  let response;
  try {
    response = await sheets.spreadsheets.values.get(
      {
        spreadsheetId: process.env.SHEET_ID,
        range: 'A2:A',
      },
      { timeout: API_TIMEOUT_MS }
    );
  } catch (err) {
    throw wrapApiError(err, '讀取目前文章編號');
  }

  const rows = response.data.values || [];
  let maxNumber = 0;
  for (const row of rows) {
    const n = parseInt(row[0], 10);
    if (Number.isFinite(n) && n > maxNumber) {
      maxNumber = n;
    }
  }

  return maxNumber + 1;
}

/**
 * 在試算表新增一列紀錄：編號、日期、上稿狀態（固定「草稿」）、題目。
 * @param {object} params
 * @param {number} params.number 文章編號
 * @param {string} params.date 日期（YYYY-MM-DD）
 * @param {string} params.title 文章標題
 * @returns {Promise<void>}
 */
async function appendRow({ number, date, title }) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(
      `Google Sheets 未設定（缺少 ${missing.join('、')}），無法寫入記錄`
    );
  }

  const sheets = getSheetsClient();

  try {
    await sheets.spreadsheets.values.append(
      {
        spreadsheetId: process.env.SHEET_ID,
        range: 'A:D',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[number, date, '草稿', title]],
        },
      },
      { timeout: API_TIMEOUT_MS }
    );
  } catch (err) {
    throw wrapApiError(err, '寫入試算表記錄');
  }
}

module.exports = {
  missingEnv,
  getNextArticleNumber,
  appendRow,
};
