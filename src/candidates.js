'use strict';

// 隅消息上稿系統 — 候選題目讀取/狀態切換
// 讀寫對象是 src/research.js 寫入的「候選題目」分頁(研究段產出的候選清單)。
// 這裡只負責「列出候選」跟「切換狀態」跟「算出去重清單」，供上稿系統網頁介面選題用；
// 本身不呼叫 Gemini、不產生新候選(產生新候選是 src/research.js 的工作)。

const { google } = require('googleapis');
const { getAuthClient, missingAuthEnv } = require('./googleAuth');

const SHEET_TAB_NAME = '候選題目';
// 欄位順序需與 src/research.js 的 SHEET_HEADER 保持一致：
// A 日期 / B 狀態 / C 分類 / D 題目 / E 研究說明 / F 主要語言來源 / G 台灣人興趣觸發點 / H 參考資料
const DATA_RANGE = `${SHEET_TAB_NAME}!A2:H`;

// 四態狀態常數(取代舊的「待挑選 / 已選」兩態)。STATUS_LIST 供前端下拉選單與驗證使用。
const STATUS_PENDING = '待挑選';
const STATUS_WRITE = '撰寫';
const STATUS_LATER = '之後撰寫';
const STATUS_SKIP = '不要';
const STATUS_LIST = [STATUS_PENDING, STATUS_WRITE, STATUS_LATER, STATUS_SKIP];

// 舊資料相容：改版前寫入的「已選」一律視為「撰寫」讀取，不因為讀到舊值就壞掉。
const LEGACY_STATUS_SELECTED = '已選';

// 去重清單規則的參數(見 buildDedupTitleList)。
const DEDUP_RECENT_MONTHS = 3;
const DEDUP_KEEP_MONTHS = 6;
const DEDUP_MAX_TITLES = 150;

const URL_REGEX = /https?:\/\/\S+/;

/**
 * 把 Sheet 讀到的原始狀態值正規化成四態之一。
 * 未知/空值一律視為「待挑選」；舊版「已選」視為「撰寫」。
 * @param {string} raw
 * @returns {string}
 */
function normalizeStatus(raw) {
  if (raw === LEGACY_STATUS_SELECTED) return STATUS_WRITE;
  if (STATUS_LIST.includes(raw)) return raw;
  return STATUS_PENDING;
}

/**
 * 解析「參考資料」欄位文字(src/research.js 寫入格式：每行「媒體名稱：網址」，
 * 或比對不到來源時的「來源未比對到...」備援清單)。
 * 抓出每行的網址部分(去掉媒體標籤)當作 sourceUrls，抓不到網址的行當作備註文字。
 * @param {string} raw
 * @returns {{sourceUrls: Array<{label: string, url: string}>, note: string}}
 */
function parseReferenceCell(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sourceUrls = [];
  const noteLines = [];

  for (const line of lines) {
    const match = line.match(URL_REGEX);
    if (!match) {
      noteLines.push(line);
      continue;
    }
    const url = match[0];
    const label = line.slice(0, match.index).replace(/[：:]\s*$/, '').trim();
    sourceUrls.push({ label, url });
  }

  return { sourceUrls, note: noteLines.join(' ') };
}

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
 * @returns {Promise<Array<{rowNumber:number, date:string, status:string, category:string, title:string, research:string, sourceLanguages:string, taiwanHook:string, sourceUrls:Array<{label:string,url:string}>, referenceNote:string}>>}
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
      const [date, status, category, title, research, sourceLanguages, taiwanHook, referenceRaw] = row;

      if (!title || !String(title).trim()) {
        return null; // 跳過空列
      }

      const { sourceUrls, note } = parseReferenceCell(referenceRaw);

      return {
        rowNumber,
        date: date || '',
        status: normalizeStatus(status),
        category: category || '',
        title,
        research: research || '',
        sourceLanguages: sourceLanguages || '',
        taiwanHook: taiwanHook || '',
        sourceUrls,
        referenceNote: note,
      };
    })
    .filter(Boolean);
}

/**
 * 更新單一候選列的「狀態」欄(B 欄)。
 * @param {number} rowNumber 試算表實際列號(從 2 起算)
 * @param {string} status 新狀態，必須是 STATUS_LIST 四種之一
 * @returns {Promise<void>}
 */
async function setCandidateStatus(rowNumber, status) {
  if (!STATUS_LIST.includes(status)) {
    throw new Error(`無效的狀態值：${status}`);
  }

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

/**
 * 把日期字串轉成 Date 物件，解析不出來回傳 null。
 * @param {string} dateStr
 * @returns {Date|null}
 */
function parseCandidateDate(dateStr) {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 算出研究段(排程與「再搜 N 則」皆適用)呼叫 Gemini 前要塞進 prompt 的既有題目清單，
 * 讓模型避開重複主題。規則：
 * - 納入：近 3 個月內的所有候選(不分狀態，含「不要」) ＋ 近 6 個月內狀態為
 *   「撰寫」「之後撰寫」的候選。
 * - 超過 150 則時，從最舊的「待挑選 / 不要」開始移除，保留「撰寫 / 之後撰寫」。
 * - 只回傳題目文字(不含研究說明)，避免 token 膨脹並稀釋重點。
 * @returns {Promise<string[]>}
 */
async function buildDedupTitleList() {
  const items = await listCandidates();

  const now = Date.now();
  const cutoffRecentMs = now - DEDUP_RECENT_MONTHS * 30 * 24 * 60 * 60 * 1000;
  const cutoffKeepMs = now - DEDUP_KEEP_MONTHS * 30 * 24 * 60 * 60 * 1000;

  const withDate = items
    .map((item) => ({ item, date: parseCandidateDate(item.date) }))
    .filter((entry) => entry.date !== null);

  const kept = withDate.filter(({ item, date }) => {
    if (date.getTime() >= cutoffRecentMs) return true;
    if (
      (item.status === STATUS_WRITE || item.status === STATUS_LATER) &&
      date.getTime() >= cutoffKeepMs
    ) {
      return true;
    }
    return false;
  });

  if (kept.length <= DEDUP_MAX_TITLES) {
    return kept.map(({ item }) => item.title);
  }

  // 超過上限：優先移除最舊的「待挑選 / 不要」，保留「撰寫 / 之後撰寫」。
  const protectedEntries = kept.filter(
    ({ item }) => item.status === STATUS_WRITE || item.status === STATUS_LATER
  );
  const removableEntries = kept
    .filter(({ item }) => item.status === STATUS_PENDING || item.status === STATUS_SKIP)
    .sort((a, b) => a.date.getTime() - b.date.getTime()); // 舊到新

  const overBy = kept.length - DEDUP_MAX_TITLES;
  const removeCount = Math.min(overBy, removableEntries.length);
  const keptRemovable = removableEntries.slice(removeCount); // 拿掉最舊的 removeCount 筆

  return protectedEntries.concat(keptRemovable).map(({ item }) => item.title);
}

module.exports = {
  STATUS_PENDING,
  STATUS_WRITE,
  STATUS_LATER,
  STATUS_SKIP,
  STATUS_LIST,
  missingEnv,
  normalizeStatus,
  parseReferenceCell,
  listCandidates,
  setCandidateStatus,
  buildDedupTitleList,
};
