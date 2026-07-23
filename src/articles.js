'use strict';

// 隅消息上稿系統 — 撰寫段資料層
// 草稿內文存在 Sheet「文章」分頁的儲存格內(一篇一列)，不在撰寫/編輯階段寫檔到 Drive。
// Drive 只在「定稿」(既有上稿流程送出成功)時才產生 .md 檔，見 src/publish.js。
//
// 欄位順序(A–K)：
// A 文章ID / B 建立日期 / C 狀態 / D 標題 / E 來源候選題目 /
// F 內文Markdown / G 建議分類 / H 建議標籤 / I 修改指示紀錄 / J Drive檔案ID / K 參考連結
//
// K 參考連結：來自候選題目當初已驗證的來源網址(candidates.js 的 sourceUrls)，
// 建立草稿時由後端直接寫入，依原本順序排好，不經過模型、也不提供編輯——
// 只是把選題當下已知的真實連結原樣附在文章紀錄旁供編輯核對，不是模型輸出的一部分。
//
// 單一儲存格上限約 5 萬字元，2000 字中文稿(F 欄)無虞。

const { google } = require('googleapis');
const { getAuthClient, missingAuthEnv } = require('./googleAuth');

const SHEET_TAB_NAME = '文章';
const SHEET_HEADER = [
  '文章ID', '建立日期', '狀態', '標題', '來源候選題目',
  '內文Markdown', '建議分類', '建議標籤', '修改指示紀錄', 'Drive檔案ID', '參考連結',
];
const DATA_RANGE = `${SHEET_TAB_NAME}!A2:K`;
const FULL_RANGE = `${SHEET_TAB_NAME}!A:K`;

const STATUS_DRAFTING = '撰寫中';
const STATUS_FINALIZED = '已定稿';

/**
 * 檢查讀寫「文章」分頁所需的環境變數。
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
 * 確保「文章」分頁存在，且第一列是正確的表頭(邏輯與 src/research.js 的
 * ensureResearchTab 相同：分頁不存在就建立；表頭遺失時先插入一列再補表頭，
 * 避免覆蓋掉已存在的資料列)。
 * @param {import('googleapis').sheets_v4.Sheets} sheets
 * @returns {Promise<void>}
 */
async function ensureArticlesTab(sheets) {
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
      range: `${SHEET_TAB_NAME}!A1:K1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADER] },
    });
    return;
  }

  const headerRow = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${SHEET_TAB_NAME}!A1:K1`,
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
    range: `${SHEET_TAB_NAME}!A1:K1`,
    valueInputOption: 'RAW',
    requestBody: { values: [SHEET_HEADER] },
  });
}

/**
 * 讀取欄位 A(文章ID)目前最大值，回傳下一個可用 ID(最大值 + 1；無資料列時回傳 1)。
 * @param {import('googleapis').sheets_v4.Sheets} sheets
 * @returns {Promise<number>}
 */
async function getNextArticleId(sheets) {
  let response;
  try {
    response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: `${SHEET_TAB_NAME}!A2:A`,
    });
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (/Unable to parse range/i.test(message)) {
      return 1; // 分頁還不存在
    }
    throw err;
  }

  const rows = response.data.values || [];
  let maxId = 0;
  for (const row of rows) {
    const n = parseInt(row[0], 10);
    if (Number.isFinite(n) && n > maxId) {
      maxId = n;
    }
  }
  return maxId + 1;
}

/**
 * 讀取「文章」分頁全部列(含 rowNumber，供更新/定稿時定位列)。
 * 分頁尚未存在時視為沒有文章，回傳空陣列而不是報錯。
 * @returns {Promise<Array<{rowNumber:number, articleId:number, createdDate:string, status:string, title:string, sourceCandidateTitle:string, content:string, category:string, tags:string[], modelLog:string, driveFileId:string, referenceLinks:string}>>}
 */
async function listArticles() {
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
      return []; // 「文章」分頁還不存在：撰寫段尚未執行過
    }
    throw new Error(`讀取文章失敗：${message}`);
  }

  const rows = response.data.values || [];

  return rows
    .map((row, i) => {
      const rowNumber = i + 2; // A2 起算
      const [
        articleIdRaw, createdDate, status, title, sourceCandidateTitle,
        content, category, tagsRaw, modelLog, driveFileId, referenceLinks,
      ] = row;

      if (!title || !String(title).trim()) {
        return null; // 跳過空列
      }

      const articleId = parseInt(articleIdRaw, 10);
      const tags = String(tagsRaw || '')
        .split(/[,，、]/)
        .map((t) => t.trim())
        .filter(Boolean);

      return {
        rowNumber,
        articleId: Number.isFinite(articleId) ? articleId : null,
        createdDate: createdDate || '',
        status: status || '',
        title,
        sourceCandidateTitle: sourceCandidateTitle || '',
        content: content || '',
        category: category || '',
        tags,
        modelLog: modelLog || '',
        driveFileId: driveFileId || '',
        referenceLinks: referenceLinks || '',
      };
    })
    .filter(Boolean);
}

/**
 * 依狀態篩選文章列表(便於「撰寫中」頁面只列出撰寫中的文章)。
 * @param {string} status
 * @returns {Promise<Array<object>>}
 */
async function listArticlesByStatus(status) {
  const items = await listArticles();
  return items.filter((item) => item.status === status);
}

/**
 * 建立一列新的文章草稿(狀態固定「撰寫中」)。
 * @param {object} params
 * @param {string} params.title 標題(模型輸出解析而來)
 * @param {string} params.sourceCandidateTitle 來源候選題目(記錄用，不做關聯查詢)
 * @param {string} params.content 內文 Markdown(不含 metadata 三行)
 * @param {string} params.category 建議分類
 * @param {string[]} params.tags 建議標籤
 * @param {string} params.modelLabel 使用的模型標籤(例如「Claude」或「Gemini」)，寫入 I 欄供辨識
 * @param {string} [params.referenceLinks] 來源候選題目已驗證的參考連結(依序排好的純文字，見檔頭說明)，寫入 K 欄
 * @returns {Promise<{articleId: number, rowNumber: number}>}
 */
async function createArticleDraft({ title, sourceCandidateTitle, content, category, tags, modelLabel, referenceLinks }) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(`Google Sheets 未設定(缺少 ${missing.join('、')})，無法建立文章草稿`);
  }

  const sheets = getSheetsClient();
  await ensureArticlesTab(sheets);

  const articleId = await getNextArticleId(sheets);
  const today = getTodayDash();
  const tagsText = Array.isArray(tags) ? tags.join('、') : String(tags || '');
  const modelLog = `使用模型：${modelLabel || '未知'}(${today})`;

  const appendResponse = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: FULL_RANGE,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        articleId, today, STATUS_DRAFTING, title, sourceCandidateTitle || '',
        content || '', category || '', tagsText, modelLog, '', referenceLinks || '',
      ]],
    },
  });

  const updatedRange = appendResponse.data.updates && appendResponse.data.updates.updatedRange;
  const rowMatch = updatedRange && /![A-Z]+(\d+):/.exec(updatedRange);
  const rowNumber = rowMatch ? parseInt(rowMatch[1], 10) : null;

  return { articleId, rowNumber };
}

/**
 * 儲存草稿(編輯區「儲存草稿」按鈕與自動存檔共用)。標題(D 欄)是獨立欄位，
 * 跟內文(F 欄)各自更新；title 未提供時只更新內文，不動標題欄。
 * @param {number} rowNumber
 * @param {{title?: string, content: string}} params
 * @returns {Promise<void>}
 */
async function updateArticleDraft(rowNumber, { title, content }) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(`Google Sheets 未設定(缺少 ${missing.join('、')})，無法儲存草稿`);
  }

  const sheets = getSheetsClient();

  if (typeof title === 'string' && title.trim() !== '') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `${SHEET_TAB_NAME}!D${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[title]] },
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${SHEET_TAB_NAME}!F${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[content || '']] },
  });
}

/**
 * 定稿：把狀態改為「已定稿」、寫入 Drive 檔案 ID(C 欄與 J 欄)。
 * 對應既有上稿流程送出成功後呼叫，Drive .md 檔已由 src/publish.js 產生。
 * @param {number} rowNumber
 * @param {string} driveFileId
 * @returns {Promise<void>}
 */
async function finalizeArticle(rowNumber, driveFileId) {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(`Google Sheets 未設定(缺少 ${missing.join('、')})，無法標記定稿`);
  }

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${SHEET_TAB_NAME}!C${rowNumber}:C${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[STATUS_FINALIZED]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `${SHEET_TAB_NAME}!J${rowNumber}:J${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[driveFileId || '']] },
  });
}

module.exports = {
  STATUS_DRAFTING,
  STATUS_FINALIZED,
  missingEnv,
  listArticles,
  listArticlesByStatus,
  createArticleDraft,
  updateArticleDraft,
  finalizeArticle,
};
