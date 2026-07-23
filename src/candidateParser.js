'use strict';

// 隅消息上稿系統 — 手動新增候選：把使用者貼上的一段文字解析成候選題目各欄位
//
// 選用 Anthropic Claude Haiku(沿用 src/keywords.js 既有的 SDK 用法跟 API Key)，
// 沒有另外選 Gemini：這裡的任務(分類/改寫摘要/欄位切分)複雜度與 keywords.js 的
// 標題判斷相近，Haiku 延遲低、成本低就夠用，而且不必再多維護一組 Gemini 憑證。
//
// 【網址規則，最重要】絕對不讓模型自己輸出網址——網址完全不經過模型，而是用
// 正規表示式直接從使用者貼上的原始文字裡逐字抓出(extractUrls)。這樣「網址只能
// 來自貼上內容、不可能被模型生成或推測」是架構上保證的，不是靠 prompt 說了算。
// (先前研究段的 grounding 網址捏造問題就是靠類似的「不信任模型輸出網址」原則解決的，
// 這裡延續同樣的做法。)

const Anthropic = require('@anthropic-ai/sdk');
const { CATEGORIES } = require('./prompts/researchPrompt');

const MODEL_ID = 'claude-haiku-4-5-20251001';
const MAX_INPUT_LENGTH = 6000;
const API_TIMEOUT_MS = 30000;

const URL_REGEX = /https?:\/\/[^\s"'<>()]+/g;

/**
 * 從文字裡逐字抓出所有網址(去重，保留原始出現順序)。
 * @param {string} text
 * @returns {string[]}
 */
function extractUrls(text) {
  const matches = String(text || '').match(URL_REGEX) || [];
  const seen = new Set();
  const urls = [];
  for (const url of matches) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/**
 * 移除模型回應中可能包在外層的 ```json ... ``` 或 ``` ... ``` code fence。
 * @param {string} text
 * @returns {string}
 */
function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

/**
 * 組合傳給 Claude 的 prompt。刻意不要求模型輸出網址欄位——網址由程式端的
 * extractUrls() 另外處理，模型完全不需要(也不被允許)碰網址。
 * @param {string} truncatedText
 * @returns {string}
 */
function buildPrompt(truncatedText) {
  return `你是新聞編輯的助手。使用者貼上了一段筆記／報導摘錄(可能是不完整的片段)，請幫忙拆解、補齊成候選題目所需的欄位。原始文字裡如果出現網址，那些網址會由程式另外處理，你不需要、也不要在回答中提到或輸出任何網址。

原始文字：
---
${truncatedText}
---

請輸出以下欄位，缺漏的部分請依你對原始文字內容的理解合理生成補齊：
- category：分類，必須是這 ${CATEGORIES.length} 個之一：${CATEGORIES.join('、')}，選最貼切的一個。
- title：題目(簡潔的標題)
- research：研究說明(整理、改寫原始文字的重點，可補充背景，200-400 字)
- sourceLanguages：這則新聞/題材主要語言來源的推測(例如「英文」「西班牙文」；不確定就填「不明」)
- taiwanHook：台灣人興趣觸發點(簡述為何這件事能引發台灣讀者的共鳴或好奇)

只回傳一個 JSON 物件，不要有任何說明文字、不要用 markdown 條列、不要用任何 code fence，格式如下：
{"category":"...","title":"...","research":"...","sourceLanguages":"...","taiwanHook":"..."}`;
}

/**
 * 呼叫 Claude Haiku，把使用者貼上的原始文字解析成候選題目欄位。
 * referenceUrls 完全不經過模型，直接從 rawText 用正規表示式抓出。
 * @param {string} rawText 使用者貼上的原始文字
 * @returns {Promise<{category: string, title: string, research: string, sourceLanguages: string, taiwanHook: string, referenceUrls: string[]}>}
 */
async function parseManualCandidateText(rawText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('缺少 ANTHROPIC_API_KEY，無法執行 AI 解析');
  }

  const safeText = typeof rawText === 'string' ? rawText : '';
  const truncated = safeText.slice(0, MAX_INPUT_LENGTH);
  const referenceUrls = extractUrls(safeText);

  const client = new Anthropic({ timeout: API_TIMEOUT_MS, maxRetries: 1 });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 800,
      messages: [{ role: 'user', content: buildPrompt(truncated) }],
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(`呼叫 Claude API 時發生錯誤(${detail})`);
  }

  const textBlock = (response.content || []).find((block) => block && block.type === 'text');
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error('模型回傳格式無法解析');
  }

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(textBlock.text));
  } catch (err) {
    throw new Error('模型回傳格式無法解析為 JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('模型回傳格式無法解析');
  }

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (!title) {
    throw new Error('AI 沒有產生題目，請補充更多內容後再試一次');
  }

  const category = CATEGORIES.includes(parsed.category) ? parsed.category : '';
  const research = typeof parsed.research === 'string' ? parsed.research.trim() : '';
  const sourceLanguages = typeof parsed.sourceLanguages === 'string' ? parsed.sourceLanguages.trim() : '';
  const taiwanHook = typeof parsed.taiwanHook === 'string' ? parsed.taiwanHook.trim() : '';

  return { category, title, research, sourceLanguages, taiwanHook, referenceUrls };
}

module.exports = {
  extractUrls,
  parseManualCandidateText,
};
