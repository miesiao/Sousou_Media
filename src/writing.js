'use strict';

// 隅消息上稿系統 — 撰寫段
// 依候選題目資料呼叫 Claude 或 Gemini 生成文章初稿(不含研究/搜尋，純撰寫)。
// Prompt 內容集中在 src/prompts/writingPrompt.js，這裡只負責呼叫 API、解析回應。
// 想換 model 版本，改下面的 CLAUDE_MODEL / GEMINI_MODEL 常數
// (2026-07-24 時以 ListModels/models API 現查過：Claude 側 claude-sonnet-5 為主力非最輕量模型；
// Gemini 側取 gemini-pro-latest，是官方維護的 Pro 線最新穩定別名，品質優於 flash 系列)。

const Anthropic = require('@anthropic-ai/sdk');
const { buildWritingSystemPrompt, buildWritingUserPrompt } = require('./prompts/writingPrompt');

const CLAUDE_MODEL = 'claude-sonnet-5';
const GEMINI_MODEL = 'gemini-pro-latest';

// 長文生成較久，後端 timeout 拉到 120 秒(前端顯示進度並停用按鈕)。
const API_TIMEOUT_MS = 120000;

const MODEL_LIST = ['claude', 'gemini'];

/**
 * 檢查指定模型所需的環境變數。
 * @param {string} model 'claude' | 'gemini'
 * @returns {string[]}
 */
function missingEnv(model) {
  if (model === 'claude') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    return typeof apiKey === 'string' && apiKey.trim() !== '' ? [] : ['ANTHROPIC_API_KEY'];
  }
  if (model === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    return typeof apiKey === 'string' && apiKey.trim() !== '' ? [] : ['GEMINI_API_KEY'];
  }
  return ['未知的模型'];
}

/**
 * 呼叫 Claude(沿用專案既有的 Anthropic SDK)。
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>}
 */
async function callClaude(systemPrompt, userPrompt) {
  const client = new Anthropic({ timeout: API_TIMEOUT_MS, maxRetries: 1 });

  let response;
  try {
    response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(`呼叫 Claude API 時發生錯誤(${detail})`);
  }

  const textBlock = (response.content || []).find((block) => block && block.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error('Claude 回應中找不到文字內容');
  }
  return textBlock.text;
}

/**
 * 呼叫 Gemini(沿用 src/research.js 的呼叫方式，不開搜尋 grounding — 撰寫不需要搜尋)。
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>}
 */
async function callGemini(systemPrompt, userPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini API 回應狀態碼 ${response.status}：${detail.slice(0, 500)}`);
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const textPart = Array.isArray(parts) ? parts.find((p) => typeof p.text === 'string') : null;

  if (!textPart) {
    throw new Error('Gemini API 回應中找不到文字內容(可能被安全過濾攔截)');
  }
  return textPart.text;
}

// 解析輸出最前面三行 metadata 用的正則(容忍全形/半形冒號)。
const META_LINE_REGEXES = {
  title: /^\s*標題[:：]\s*(.+?)\s*$/,
  category: /^\s*建議分類[:：]\s*(.+?)\s*$/,
  tags: /^\s*建議標籤[:：]\s*(.+?)\s*$/,
};

/**
 * 把模型輸出拆成 { title, category, tags, content }：
 * 前面三行 metadata 各自解析，其餘(不含 metadata 三行與其後多餘空行)當作內文本體。
 * 只在前 15 行內尋找 metadata 行，避免內文中剛好出現「標題：」等字樣被誤判。
 * @param {string} rawText
 * @returns {{title: string, category: string, tags: string[], content: string}}
 */
function parseDraftOutput(rawText) {
  const lines = String(rawText || '').replace(/^﻿/, '').split('\n');

  let title = '';
  let category = '';
  let tags = [];
  const metaLineIndices = new Set();
  const scanLimit = Math.min(lines.length, 15);

  for (let i = 0; i < scanLimit; i += 1) {
    const line = lines[i];

    if (!title) {
      const m = META_LINE_REGEXES.title.exec(line);
      if (m) {
        title = m[1].trim();
        metaLineIndices.add(i);
        continue;
      }
    }
    if (!category) {
      const m = META_LINE_REGEXES.category.exec(line);
      if (m) {
        category = m[1].trim();
        metaLineIndices.add(i);
        continue;
      }
    }
    if (tags.length === 0) {
      const m = META_LINE_REGEXES.tags.exec(line);
      if (m) {
        tags = m[1]
          .split(/[,，、]/)
          .map((t) => t.trim())
          .filter(Boolean);
        metaLineIndices.add(i);
        continue;
      }
    }
  }

  const bodyLines = lines.filter((_, i) => !metaLineIndices.has(i));
  const content = bodyLines.join('\n').replace(/^\s*\n+/, '').trimEnd();

  return { title, category, tags, content };
}

/**
 * 依候選題目資料生成一篇文章初稿。
 * @param {object} params
 * @param {{title:string, category?:string, research?:string, sourceLanguages?:string, taiwanHook?:string, mediaNames?:string[]}} params.candidate
 * @param {string} params.model 'claude' | 'gemini'
 * @returns {Promise<{title: string, category: string, tags: string[], content: string, rawText: string}>}
 */
async function generateDraft({ candidate, model }) {
  if (!MODEL_LIST.includes(model)) {
    throw new Error(`不支援的模型：${model}`);
  }

  const missing = missingEnv(model);
  if (missing.length > 0) {
    throw new Error(`無法生成草稿(缺少 ${missing.join('、')})`);
  }

  const systemPrompt = buildWritingSystemPrompt();
  const userPrompt = buildWritingUserPrompt(candidate);

  const rawText = model === 'claude'
    ? await callClaude(systemPrompt, userPrompt)
    : await callGemini(systemPrompt, userPrompt);

  const parsed = parseDraftOutput(rawText);
  if (!parsed.title || !parsed.content) {
    throw new Error('模型回應無法解析出標題或內文，請重試(可能是輸出格式跑掉)');
  }

  return { ...parsed, rawText };
}

module.exports = {
  MODEL_LIST,
  CLAUDE_MODEL,
  GEMINI_MODEL,
  missingEnv,
  parseDraftOutput,
  generateDraft,
};
