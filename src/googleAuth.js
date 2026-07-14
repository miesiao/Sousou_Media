'use strict';

// 隅消息上稿系統 — Google API 共用認證
// 規格第 7.1 節：Service Account 認證，金鑰整份存在環境變數 GOOGLE_SERVICE_ACCOUNT_JSON。
// 本模組提供 lazy singleton 的 auth client，給 googleDrive.js / sheets.js 共用。

const { google } = require('googleapis');

// 兩個服務都需要的權限範圍。
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

// lazy singleton：第一次呼叫 getAuthClient() 時才建立，之後重複使用。
let authClientInstance = null;

/**
 * 檢查 GOOGLE_SERVICE_ACCOUNT_JSON 是否已設定(存在且 trim 後非空字串)。
 * @returns {string[]} 缺少時回傳 ['GOOGLE_SERVICE_ACCOUNT_JSON']，否則回傳 []
 */
function missingAuthEnv() {
  const value = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (typeof value !== 'string' || value.trim() === '') {
    return ['GOOGLE_SERVICE_ACCOUNT_JSON'];
  }
  return [];
}

/**
 * 取得（必要時建立）Google Auth client，供 Drive / Sheets API 共用。
 * - 解析失敗時 throw 清楚錯誤，且絕不外洩金鑰內容。
 * - private_key 若含字面 "\n"（環境變數常見情況），轉回真正換行。
 * @returns {import('google-auth-library').GoogleAuth}
 */
function getAuthClient() {
  if (authClientInstance) {
    return authClientInstance;
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON 格式錯誤，無法解析為 JSON，請確認貼入的是完整的 Service Account 金鑰'
    );
  }

  if (
    credentials &&
    typeof credentials.private_key === 'string' &&
    credentials.private_key.includes('\\n')
  ) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }

  authClientInstance = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });

  return authClientInstance;
}

module.exports = {
  SCOPES,
  missingAuthEnv,
  getAuthClient,
};
