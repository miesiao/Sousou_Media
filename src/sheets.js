'use strict';

// 隅消息上稿系統 — Google Sheets 整合
// 規格第 7.3 節：SHEET_ID 指向的試算表，欄位 A–G。
// 後端只 append 新列並填 A–E（F 社群狀態、G 備註留空給後續流程使用）。

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
 * 在試算表新增一列紀錄，填入 A–E（發佈狀態固定寫「草稿」），F、G 留空。
 * @param {object} params
 * @param {string} params.date 日期（YYYY-MM-DD）
 * @param {string} params.title 文章標題
 * @param {string} params.wpDraftUrl WordPress 草稿連結
 * @param {string} params.driveFolderUrl Drive 資料夾連結
 * @returns {Promise<void>}
 */
async function appendRow({ date, title, wpDraftUrl, driveFolderUrl }) {
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
        range: 'A:G',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[date, title, wpDraftUrl, driveFolderUrl, '草稿', '', '']],
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
  appendRow,
};
