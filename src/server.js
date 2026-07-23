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

// POST /api/submit — 送出文章：建 task → AI 判斷標題+抽關鍵字 → 搜圖。
// articleRowNumber(選填)：若是從「撰寫中」草稿編輯進來，帶入該列的 rowNumber，
// 供 /api/publish 送出成功後回頭把 Sheet「文章」分頁該列標記為「已定稿」。
app.post('/api/submit', async (req, res) => {
  const { content, articleRowNumber } = req.body || {};

  if (!content || typeof content !== 'string' || content.trim() === '') {
    return res.status(400).json({ error: '缺少文章內容' });
  }

  const taskId = crypto.randomUUID();

  // 1. AI 判斷標題 + 抽關鍵字(失敗不讓整個請求失敗，改用備援標題判斷)。
  const { analyzeArticle, fallbackTitle, stripTitleFromContent } = require('./keywords');
  let title = '';
  let keywords = [];
  let keywordError = null;
  try {
    const result = await analyzeArticle(content);
    title = result.title;
    keywords = Array.isArray(result.keywords) ? result.keywords : [];
  } catch (err) {
    console.error('[submit] AI 文章分析失敗：', err && err.message);
    keywordError = err && err.message ? err.message : 'AI 文章分析失敗';
    title = fallbackTitle(content);
  }

  // 2. 從內文移除與標題相同的那一行，避免標題重複出現。
  const markdown = stripTitleFromContent(content, title);

  // 3. 建立 task。
  const task = {
    title,
    markdown,
    candidates: [],
    createdAt: Date.now(),
    articleRowNumber: Number.isInteger(articleRowNumber) ? articleRowNumber : null,
  };
  tasks.set(taskId, task);

  // 4. 有關鍵字才搜圖。
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

  // 5. 回傳。
  return res.json({
    taskId,
    title,
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

// GET /api/candidates — 讀取「候選題目」分頁(研究段產出，供人工選題)。
app.get('/api/candidates', async (req, res) => {
  try {
    const { listCandidates, STATUS_LIST } = require('./candidates');
    const { CATEGORIES } = require('./prompts/researchPrompt');
    const items = await listCandidates();
    return res.json({ items, statuses: STATUS_LIST, categories: CATEGORIES });
  } catch (err) {
    console.error('[candidates] 讀取候選題目失敗：', err && err.message);
    return res.status(500).json({ error: `讀取候選題目失敗：${err && err.message}` });
  }
});

// POST /api/candidates/status — 切換單一候選的狀態(已選／考慮／未決／棄用 四態)。
app.post('/api/candidates/status', async (req, res) => {
  const { rowNumber, status } = req.body || {};
  const { STATUS_LIST, setCandidateStatus } = require('./candidates');

  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    return res.status(400).json({ error: '缺少或無效的 rowNumber' });
  }
  if (!STATUS_LIST.includes(status)) {
    return res.status(400).json({ error: '無效的狀態值' });
  }

  try {
    await setCandidateStatus(rowNumber, status);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[candidates] 更新候選狀態失敗：', err && err.message);
    return res.status(500).json({ error: `更新候選狀態失敗：${err && err.message}` });
  }
});

// 「再搜 N 則」的後端等待上限：Gemini 帶搜尋 grounding 可能要 30-60 秒，
// 拉到 90 秒讓大多數情況能正常等到結果；真的逾時就先回應讓前端解除鎖定，
// 背景呼叫仍可能繼續跑完並寫入 Sheet(之後按「重新整理」就看得到)。
const CANDIDATES_RESEARCH_TIMEOUT_MS = 90000;
const CANDIDATES_RESEARCH_COUNT = 3;

// POST /api/candidates/research — 呼叫 Gemini 產生 3 則新候選，append 進 Sheet。
app.post('/api/candidates/research', async (req, res) => {
  const { missingEnv, generateCandidates } = require('./research');

  const missing = missingEnv();
  if (missing.length > 0) {
    return res.status(500).json({
      error: `無法從網頁觸發補搜候選題目(缺少 ${missing.join('、')})`,
    });
  }

  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), CANDIDATES_RESEARCH_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      generateCandidates(CANDIDATES_RESEARCH_COUNT).then((items) => ({ items })),
      timeout,
    ]);

    if (result.timedOut) {
      return res.status(504).json({
        error: '搜尋逾時(超過 90 秒)，可能仍在背景寫入，請稍後按「重新整理」查看是否已出現新候選。',
      });
    }

    return res.json({ ok: true, count: result.items.length });
  } catch (err) {
    console.error('[candidates] 補搜候選題目失敗：', err && err.message);
    return res.status(500).json({ error: `補搜候選題目失敗：${err && err.message}` });
  }
});

// POST /api/candidates/parse — 手動新增第一步：AI 解析貼上的文字，只回傳結果不寫入 Sheet。
app.post('/api/candidates/parse', async (req, res) => {
  const { text } = req.body || {};

  if (!text || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: '缺少貼上的文字內容' });
  }

  try {
    const { parseManualCandidateText } = require('./candidateParser');
    const result = await parseManualCandidateText(text);
    return res.json(result);
  } catch (err) {
    console.error('[candidates] AI 解析失敗：', err && err.message);
    return res.status(500).json({ error: `AI 解析失敗：${err && err.message}` });
  }
});

// POST /api/candidates — 手動新增第二步：人工在預覽表單確認/修改後才真正寫入 Sheet，
// 走跟自動產出完全相同的後續流程。
app.post('/api/candidates', async (req, res) => {
  const { title, category, research, sourceLanguages, taiwanHook, links } = req.body || {};
  const { missingEnv } = require('./candidates');
  const { appendManualCandidate } = require('./research');
  const { CATEGORIES } = require('./prompts/researchPrompt');

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: '缺少題目' });
  }
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: '無效的分類' });
  }

  const missing = missingEnv();
  if (missing.length > 0) {
    return res.status(500).json({ error: `無法新增候選題目(缺少 ${missing.join('、')})` });
  }

  try {
    await appendManualCandidate({
      title: title.trim(),
      category: category || '',
      research: typeof research === 'string' ? research.trim() : '',
      sourceLanguages: typeof sourceLanguages === 'string' ? sourceLanguages.trim() : '',
      taiwanHook: typeof taiwanHook === 'string' ? taiwanHook.trim() : '',
      referenceText: typeof links === 'string' ? links.trim() : '',
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[candidates] 手動新增候選失敗：', err && err.message);
    return res.status(500).json({ error: `手動新增候選失敗：${err && err.message}` });
  }
});

// 撰寫段生成初稿：長文生成較久，後端 timeout 拉到 120 秒。
const WRITE_TIMEOUT_MS = 120000;

// POST /api/write — 依候選題目資料生成一篇文章初稿(Claude 或 Gemini)，寫入 Sheet「文章」分頁一列(狀態「撰寫中」)。
// 同一則候選可重複生成，每次都會建立新的一列，不做「只能生成一次」的限制。
app.post('/api/write', async (req, res) => {
  const { rowNumber, model } = req.body || {};

  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    return res.status(400).json({ error: '缺少或無效的候選題目 rowNumber' });
  }

  const { MODEL_LIST, missingEnv: writingMissingEnv, generateDraft } = require('./writing');
  if (!MODEL_LIST.includes(model)) {
    return res.status(400).json({ error: `無效的模型：${model}` });
  }

  const missing = writingMissingEnv(model);
  if (missing.length > 0) {
    return res.status(500).json({ error: `無法生成草稿(缺少 ${missing.join('、')})` });
  }

  try {
    const { listCandidates } = require('./candidates');
    const items = await listCandidates();
    const candidate = items.find((c) => c.rowNumber === rowNumber);
    if (!candidate) {
      return res.status(404).json({ error: '找不到指定的候選題目' });
    }

    // 參考資料只帶媒體名稱給模型，不帶網址(避免模型抄錯或杜撰網址)。
    const mediaNames = Array.from(new Set(
      (candidate.sourceUrls || [])
        .map((s) => s.mediaLabel)
        .filter(Boolean)
    ));

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('生成逾時(超過 120 秒)，請重試')), WRITE_TIMEOUT_MS);
    });

    const draft = await Promise.race([
      generateDraft({
        candidate: {
          title: candidate.title,
          category: candidate.category,
          research: candidate.research,
          sourceLanguages: candidate.sourceLanguages,
          taiwanHook: candidate.taiwanHook,
          mediaNames,
        },
        model,
      }),
      timeout,
    ]);

    const { createArticleDraft } = require('./articles');
    const modelLabel = model === 'claude' ? 'Claude' : 'Gemini';
    const { articleId, rowNumber: articleRowNumber } = await createArticleDraft({
      title: draft.title,
      sourceCandidateTitle: candidate.title,
      content: draft.content,
      category: draft.category,
      tags: draft.tags,
      modelLabel,
    });

    return res.json({ ok: true, articleId, rowNumber: articleRowNumber, model: modelLabel });
  } catch (err) {
    console.error('[write] 生成草稿失敗：', err && err.message);
    return res.status(500).json({ error: `生成草稿失敗：${err && err.message}` });
  }
});

// GET /api/articles — 讀取「文章」分頁，預設只回傳「撰寫中」的列(供「撰寫中」頁面列表用)。
app.get('/api/articles', async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status.trim() !== ''
    ? req.query.status.trim()
    : '撰寫中';

  try {
    const { listArticlesByStatus } = require('./articles');
    const items = await listArticlesByStatus(status);
    return res.json({ items });
  } catch (err) {
    console.error('[articles] 讀取文章失敗：', err && err.message);
    return res.status(500).json({ error: `讀取文章失敗：${err && err.message}` });
  }
});

// POST /api/articles/:rowNumber/draft — 儲存草稿(編輯區「儲存草稿」按鈕與停止輸入 3 秒後自動存檔共用)。
// title 是獨立欄位(可選)，未提供時只更新內文，不動標題欄。
app.post('/api/articles/:rowNumber/draft', async (req, res) => {
  const rowNumber = parseInt(req.params.rowNumber, 10);
  const { title, content } = req.body || {};

  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    return res.status(400).json({ error: '缺少或無效的 rowNumber' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: '缺少文章內容' });
  }

  try {
    const { updateArticleDraft } = require('./articles');
    await updateArticleDraft(rowNumber, { title, content });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[articles] 儲存草稿失敗：', err && err.message);
    return res.status(500).json({ error: `儲存草稿失敗：${err && err.message}` });
  }
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

    // 若這次送出來自「撰寫中」草稿編輯(task.articleRowNumber 有值)且 Drive 存檔成功，
    // 視為定稿：把 Sheet「文章」分頁該列狀態改為「已定稿」並記錄 Drive 檔案 ID。
    // Drive 沒成功就不標記定稿，讓該列繼續留在「撰寫中」，避免定稿卻沒有檔案 ID 的不一致狀態。
    if (task.articleRowNumber && result.steps && result.steps.drive && result.steps.drive.status === 'ok' && result.steps.drive.fileId) {
      try {
        const { finalizeArticle } = require('./articles');
        await finalizeArticle(task.articleRowNumber, result.steps.drive.fileId);
        result.articleFinalized = true;
      } catch (err) {
        console.error('[publish] 標記文章定稿失敗(不影響上稿結果)：', err && err.message);
        result.articleFinalized = false;
      }
    }

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
