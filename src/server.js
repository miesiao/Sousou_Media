'use strict';

// 隅消息上稿系統 — Express 服務進入點
// 流程：編輯貼文章 → 抽關鍵字 → 並行搜四個圖庫 → 挑圖 → 一次完成 WP 草稿 / Drive 存檔 / Sheets 記錄。
// 部署於 Railway，必須 bind 0.0.0.0。使用 Node 20 內建 fetch。

const crypto = require('crypto');
const path = require('path');

// 本機開發：若專案根目錄有 .env 檔就載入(填入 process.env)，且不覆蓋已存在的變數。
// Railway 上沒有 .env 檔，這行不會有任何作用也不會報錯，正式環境變數一律由 Railway 注入。
require('dotenv').config();

const express = require('express');

const { checkEnvAtStartup } = require('./config');
const { login, requireAuth, isAuthenticated } = require('./auth');

// 啟動時先檢查環境變數(印出狀態，不印值)。
checkEnvAtStartup();

const app = express();

app.use(express.json({ limit: '2mb' }));
// 服務前端靜態頁面(public/index.html 由其他人開發)。
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- in-memory 任務暫存 ----
// taskId → { title, markdown, candidates: [], createdAt }
const tasks = new Map();

// 任務過期時間：建立超過 2 小時清除。
const TASK_TTL_MS = 2 * 60 * 60 * 1000;

// 定期清理過期任務(每 10 分鐘掃一次)。
setInterval(() => {
  const now = Date.now();
  for (const [taskId, task] of tasks) {
    if (now - task.createdAt > TASK_TTL_MS) {
      tasks.delete(taskId);
    }
  }
}, 10 * 60 * 1000).unref();

/**
 * 取出未過期的任務，過期則刪除並回傳 null。
 * @param {string} taskId
 * @returns {object|null}
 */
function getLiveTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (Date.now() - task.createdAt > TASK_TTL_MS) {
    tasks.delete(taskId);
    return null;
  }
  return task;
}

// ---- 路由 ----

// POST /api/login — 密碼登入，成功發 session cookie。
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};

  let token;
  try {
    token = login(password);
  } catch (err) {
    // ADMIN_PASSWORD 未設定：回 500，訊息來自 auth.js。
    return res.status(500).json({ error: err.message });
  }

  if (!token) {
    return res.status(401).json({ error: '密碼錯誤' });
  }

  res.setHeader(
    'Set-Cookie',
    `session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`
  );
  return res.json({ ok: true });
});

// GET /api/session — 查詢目前是否已登入(不套 middleware)。
app.get('/api/session', (req, res) => {
  return res.json({ authenticated: isAuthenticated(req) });
});

// 以下所有路由皆需登入。
app.use('/api', requireAuth);

// POST /api/submit — 送出文章：建 task → 抽關鍵字 → 搜圖。
app.post('/api/submit', async (req, res) => {
  const { title, markdown } = req.body || {};

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: '缺少文章標題' });
  }
  if (!markdown || typeof markdown !== 'string' || markdown.trim() === '') {
    return res.status(400).json({ error: '缺少文章內容(Markdown)' });
  }

  // 1. 建立 task。
  const taskId = crypto.randomUUID();
  const task = {
    title,
    markdown,
    candidates: [],
    createdAt: Date.now(),
  };
  tasks.set(taskId, task);

  // 2. 抽關鍵字(失敗不讓整個請求失敗)。
  let keywords = [];
  let keywordError = null;
  try {
    const { extractKeywords } = require('./keywords');
    const result = await extractKeywords(title, markdown);
    keywords = (result && Array.isArray(result.keywords)) ? result.keywords : [];
  } catch (err) {
    console.error('[submit] 關鍵字抽取失敗：', err && err.message);
    keywords = [];
    keywordError = err && err.message ? err.message : '關鍵字抽取失敗';
  }

  // 3. 有關鍵字才搜圖。
  let candidates = [];
  let sourceStatus = null;
  if (keywords.length > 0) {
    try {
      const { searchAllSources } = require('./imageSearch');
      const searchResult = await searchAllSources(keywords);
      candidates = (searchResult && Array.isArray(searchResult.candidates))
        ? searchResult.candidates
        : [];
      sourceStatus = (searchResult && searchResult.sourceStatus) || null;
      task.candidates = candidates;
    } catch (err) {
      console.error('[submit] 圖庫搜尋失敗：', err && err.message);
      candidates = [];
      sourceStatus = null;
    }
  }

  // 4. 回傳。
  return res.json({
    taskId,
    keywords,
    keywordError: keywordError || null,
    candidates,
    sourceStatus,
  });
});

// POST /api/research — 針對單一關鍵字補搜圖，併入既有 candidates。
app.post('/api/research', async (req, res) => {
  const { taskId, keyword } = req.body || {};

  const task = getLiveTask(taskId);
  if (!task) {
    return res.status(404).json({ error: '任務不存在或已過期，請重新送出文章' });
  }

  if (!keyword || typeof keyword !== 'string' || keyword.trim() === '') {
    return res.status(400).json({ error: '缺少搜尋關鍵字' });
  }

  let sourceStatus = null;
  try {
    const { searchAllSources, MAX_TOTAL_CANDIDATES } = require('./imageSearch');
    const searchResult = await searchAllSources([keyword]);
    const newCandidates = (searchResult && Array.isArray(searchResult.candidates))
      ? searchResult.candidates
      : [];
    sourceStatus = (searchResult && searchResult.sourceStatus) || null;

    // 以 fullUrl 去重後併入(fullUrl 缺漏時 fallback 到 id，跟 mergeRoundRobin 邏輯一致)，
    // 並重新套用候選圖總數上限，避免反覆「重新搜尋」讓清單無限增長。
    const existingKeys = new Set(task.candidates.map((c) => c.fullUrl || c.id));
    for (const candidate of newCandidates) {
      if (task.candidates.length >= MAX_TOTAL_CANDIDATES) {
        break;
      }
      const key = candidate && (candidate.fullUrl || candidate.id);
      if (candidate && !existingKeys.has(key)) {
        task.candidates.push(candidate);
        existingKeys.add(key);
      }
    }
  } catch (err) {
    console.error('[research] 圖庫搜尋失敗：', err && err.message);
    return res.status(500).json({ error: `圖庫搜尋失敗：${err && err.message}` });
  }

  return res.json({ candidates: task.candidates, sourceStatus });
});

// POST /api/publish — 上稿：WP 草稿 + Drive 存檔 + Sheets 記錄。
app.post('/api/publish', async (req, res) => {
  const { taskId, selectedIds } = req.body || {};

  const task = getLiveTask(taskId);
  if (!task) {
    return res.status(404).json({ error: '任務不存在或已過期，請重新送出文章' });
  }

  const ids = Array.isArray(selectedIds) ? selectedIds : [];

  try {
    const { publishArticle } = require('./publish');
    const result = await publishArticle(task, ids);
    // 即使部分步驟失敗也回 200，部分成功資訊在 body 內。
    return res.json(result);
  } catch (err) {
    console.error('[publish] 上稿流程發生未預期錯誤：', err && err.message);
    return res.status(500).json({ error: `上稿流程發生未預期錯誤：${err && err.message}` });
  }
});

// ---- 啟動 ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`隅消息上稿系統已啟動，監聽 0.0.0.0:${PORT}`);
});

module.exports = app;
