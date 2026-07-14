'use strict';

// 隅消息上稿系統 — Claude Haiku 關鍵字抽取模組
// 規格第 4 節：從文章標題 + 內文，抽取 2–3 組英文「視覺搜尋關鍵字」，
// 供後續呼叫圖庫(Pexels / Unsplash)搜圖使用。

const Anthropic = require('@anthropic-ai/sdk');

// 內文只取前 2000 字，足夠判斷主題，避免 prompt 過長。
const MAX_CONTENT_LENGTH = 2000;

// 照規格指定，不要改動這個字串。
const MODEL_ID = 'claude-haiku-4-5-20251001';

/**
 * 組合傳給 Claude Haiku 的 prompt(英文撰寫，對模型較穩)。
 * @param {string} title 文章標題
 * @param {string} truncatedContent 已截斷至前 2000 字的內文
 * @returns {string}
 */
function buildPrompt(title, truncatedContent) {
  return `You are helping a news editor find stock photos to illustrate an article.

Given the article title and content below, extract 2 to 3 English visual search keyword phrases that can be used to search a stock photo library (like Pexels or Unsplash) and find concrete, relevant images.

Guidelines:
- Extract VISUAL CONCEPTS, not a summary of the article's topic. Each phrase must describe something that could literally appear in a photo (a place, a subject, an action, a scene).
- Prefer specific, concrete scenes — combine location + subject + action when possible (e.g. "Guatemala coffee farm workers" rather than "Guatemala economy").
- Avoid abstract or non-visual words such as "economy", "culture", "policy", "relations", "growth".
- If the article involves a specific country or region, include that place name in at least one keyword phrase.

Respond with ONLY a JSON object in this exact shape, with no preamble, no explanation, and no markdown code fence:
{"keywords": ["Guatemala coffee farm workers", "Central America highland village", "coffee beans harvest"]}

Article title: ${title}

Article content:
${truncatedContent}`;
}

/**
 * 移除模型回應中可能包在外層的 ```json ... ``` 或 ``` ... ``` code fence。
 * @param {string} text
 * @returns {string}
 */
function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * 從 Claude 回應文字解析出 keywords 陣列。
 * 驗證：必須是非空字串陣列，只保留前 3 個，並 trim 每個字串。
 * 解析失敗或格式不符時 throw 錯誤。
 * @param {string} rawText
 * @returns {{ keywords: string[] }}
 */
function parseKeywordsResponse(rawText) {
  const cleaned = stripCodeFence(rawText);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('關鍵字抽取失敗：模型回傳格式無法解析');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.keywords) ||
    parsed.keywords.length === 0 ||
    !parsed.keywords.every((kw) => typeof kw === 'string' && kw.trim() !== '')
  ) {
    throw new Error('關鍵字抽取失敗：模型回傳格式無法解析');
  }

  const keywords = parsed.keywords.slice(0, 3).map((kw) => kw.trim());

  return { keywords };
}

/**
 * 呼叫 Claude Haiku，從文章標題與內文抽取英文視覺搜尋關鍵字。
 * @param {string} title 文章標題
 * @param {string} markdown 文章內文(Markdown 或純文字)
 * @returns {Promise<{ keywords: string[] }>}
 */
async function extractKeywords(title, markdown) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('關鍵字抽取無法執行：缺少 ANTHROPIC_API_KEY');
  }

  const safeTitle = typeof title === 'string' ? title : '';
  const safeContent = typeof markdown === 'string' ? markdown : '';
  const truncatedContent = safeContent.slice(0, MAX_CONTENT_LENGTH);

  const prompt = buildPrompt(safeTitle, truncatedContent);

  const client = new Anthropic({ timeout: 30000, maxRetries: 1 });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(`關鍵字抽取失敗：呼叫 Claude API 時發生錯誤（${detail}）`);
  }

  const textBlock = (response.content || []).find(
    (block) => block && block.type === 'text'
  );

  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error('關鍵字抽取失敗：模型回傳格式無法解析');
  }

  return parseKeywordsResponse(textBlock.text);
}

module.exports = {
  extractKeywords,
};
