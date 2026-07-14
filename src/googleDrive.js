'use strict';

// 隅消息上稿系統 — Google Drive 整合
// 規格第 7.2 節：每篇文章在 DRIVE_ROOT_FOLDER_ID 底下建立子資料夾，
// 資料夾內放文章.md、圖N.jpg、來源.txt（檔案內容由呼叫端組好傳入，本模組只負責建資料夾與上傳）。

const { google } = require('googleapis');
const { Readable } = require('stream');
const { missingAuthEnv, getAuthClient } = require('./googleAuth');

// 單一 API 呼叫的 timeout（毫秒）。
const API_TIMEOUT_MS = 30000;

// 資料夾名稱截斷長度（規格：標題過長截斷至 40 字）。
const TITLE_MAX_LENGTH = 40;

// 不合法的檔名字元（Windows / Drive 皆不建議使用）。
const INVALID_CHARS_REGEX = /[/\\:*?"<>|]/g;
// 控制字元（ASCII 0-31）。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x1f]/g;

/**
 * 檢查建立文章資料夾 / 上傳檔案所需的環境變數。
 * @returns {string[]} 缺少的環境變數名稱陣列
 */
function missingEnv() {
  const missing = [];
  if (missingAuthEnv().length > 0) {
    missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
  if (typeof rootFolderId !== 'string' || rootFolderId.trim() === '') {
    missing.push('DRIVE_ROOT_FOLDER_ID');
  }
  return missing;
}

/**
 * 清理標題：移除不合法字元與控制字元、trim、截斷至 40 字元。
 * 使用字串 slice（BMP 中文字元皆為單一 code unit，可接受）。
 * @param {string} title
 * @returns {string}
 */
function sanitizeTitle(title) {
  const cleaned = String(title == null ? '' : title)
    .replace(INVALID_CHARS_REGEX, '')
    .replace(CONTROL_CHARS_REGEX, '')
    .trim();

  return Array.from(cleaned).slice(0, TITLE_MAX_LENGTH).join('');
}

/**
 * 取得 Drive API client。
 * 若 .env 有 GOOGLE_OAUTH_REFRESH_TOKEN 則用個人帳號 OAuth2（有 Drive 配額）；
 * 否則 fallback 到 Service Account（個人帳號需前者才能上傳檔案）。
 * @returns {import('googleapis').drive_v3.Drive}
 */
function getDriveClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: 'v3', auth: oauth2 });
  }

  const auth = getAuthClient();
  return google.drive({ version: 'v3', auth });
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
    '請確認資料夾已分享給 Service Account 的 email（編輯權限）且 ID 正確';
  }

  const statusText = status ? `HTTP ${status}` : '未知狀態';
  return new Error(
    `${action}失敗（${statusText}）：${summary}${hint ? '，' + hint : ''}`
  );
}

/**
 * 為文章建立子資料夾（資料夾名稱：YYYY-MM-DD_標題，標題已 sanitize 並截斷）。
 * @param {string} title 文章標題
 * @param {string} dateStr 日期字串（YYYY-MM-DD）
 * @returns {Promise<{ folderId: string, folderUrl: string }>}
 */
async function createArticleFolder(title, dateStr) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(
      `Google Drive 未設定（缺少 ${missing.join('、')}），無法建立資料夾`
    );
  }

  const folderName = `${dateStr}_${sanitizeTitle(title)}`;
  const drive = getDriveClient();

  let response;
  try {
    response = await drive.files.create(
      {
        supportsAllDrives: true,
        requestBody: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [process.env.DRIVE_ROOT_FOLDER_ID],
        },
        fields: 'id',
      },
      { timeout: API_TIMEOUT_MS }
    );
  } catch (err) {
    throw wrapApiError(err, '建立文章資料夾');
  }

  const folderId = response.data.id;
  return {
    folderId,
    folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
  };
}

/**
 * 上傳檔案到指定資料夾。
 * @param {string} folderId 目標資料夾 ID
 * @param {string} name 檔案名稱（例如 文章.md、圖1.jpg、來源.txt）
 * @param {Buffer|string} content 檔案內容
 * @param {string} mimeType 檔案的 MIME type
 * @returns {Promise<{ fileId: string }>}
 */
async function uploadFile(folderId, name, content, mimeType) {
  const missing = missingAuthEnv();
  if (missing.length > 0) {
    throw new Error(
      `Google Drive 未設定（缺少 ${missing.join('、')}），無法上傳檔案`
    );
  }

  const drive = getDriveClient();
  const body = Readable.from(content);

  let response;
  try {
    response = await drive.files.create(
      {
        supportsAllDrives: true,
        requestBody: {
          name,
          parents: [folderId],
        },
        media: {
          mimeType,
          body,
        },
        fields: 'id',
      },
      { timeout: API_TIMEOUT_MS }
    );
  } catch (err) {
    throw wrapApiError(err, `上傳檔案「${name}」`);
  }

  return { fileId: response.data.id };
}

module.exports = {
  missingEnv,
  sanitizeTitle,
  createArticleFolder,
  uploadFile,
};
