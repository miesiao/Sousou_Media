'use strict';

// 隅消息上稿系統 — Claude Haiku 文章分析模組
// 編輯貼上的是單一「文章內容」欄位(可能已包含「標題：」這類標籤行、建議分類、建議標籤等)，
// 這裡從中判斷文章標題，並抽取 2–3 組英文「視覺搜尋關鍵字」，供後續呼叫圖庫(Pexels / Unsplash)搜圖使用。

const Anthropic = require('@anthropic-ai/sdk');

// 內文只取前 2000 字，足夠判斷標題與主題，避免 prompt 過長。
const MAX_CONTENT_LENGTH = 2000;

// 照規格指定，不要改動這個字串。
const MODEL_ID = 'claude-haiku-4-5-20251001';

// 用來辨識內容中「標題：」這類標籤行的正則表達式。
const TITLE_LABEL_LINE_REGEX = /^[ \t]*(?:文章)?標題[:：]\s*(.+?)\s*$/;

/**
 * 組合傳給 Claude Haiku 的 prompt(英文撰寫，對模型較穩)。
 * @param {string} truncatedContent 已截斷至前 2000 字的貼稿內容
 * @returns {string}
 */
function buildPrompt(truncatedContent) {
  return `You are helping a news editor prepare a pasted article for publishing.

The editor pasted the raw article content below. Do two things:

1. Identify the article's title. If the content contains an explicit label line such as "標題：" or "標題:" followed by text, use that exact text (trimmed, unmodified, same language, do not translate or rephrase) as the title. Otherwise infer a concise headline (not a summary) from the article, in the same language as the article.
2. Extract 2 to 3 English visual search keyword phrases that can be used to search a stock photo library (like Pexels or Unsplash) and find concrete, relevant images.

Guidelines for keywords:
- Extract VISUAL CONCEPTS, not a summary of the article's topic. Each phrase must describe something that could literally appear in a photo (a place, a subject, an action, a scene).
- Prefer specific, concrete scenes — combine location + subject + action when possible (e.g. "Guatemala coffee farm workers" rather than "Guatemala economy").
- Avoid abstract or non-visual words such as "economy", "culture", "policy", "relations", "growth".
- If the article involves a specific country or region, include that place name in at least one keyword phrase.

Respond with ONLY a JSON object in this exact shape, with no preamble, no explanation, and no markdown code fence:
{"title": "文章標題", "keywords": ["Guatemala coffee farm workers", "Central America highland village", "coffee beans harvest"]}

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
 * 從 Claude 回應文字解析出 title 與 keywords。
 * title 為必要欄位(缺少或解析失敗時 throw)；keywords 允許缺漏或格式不符時退化為空陣列。
 * @param {string} rawText
 * @returns {{ title: string, keywords: string[] }}
 */
function parseAnalysisResponse(rawText) {
  const cleaned = stripCodeFence(rawText);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('文章分析失敗：模型回傳格式無法解析');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.title !== 'string' ||
    parsed.title.trim() === ''
  ) {
    throw new Error('文章分析失敗：模型回傳格式無法解析');
  }

  const title = parsed.title.trim();
  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords
        .filter((kw) => typeof kw === 'string' && kw.trim() !== '')
        .slice(0, 3)
        .map((kw) => kw.trim())
    : [];

  return { title, keywords };
}

/**
 * 呼叫 Claude Haiku，從貼稿內容判斷標題並抽取英文視覺搜尋關鍵字。
 * @param {string} content 編輯貼上的完整文章內容
 * @returns {Promise<{ title: string, keywords: string[] }>}
 */
async function analyzeArticle(content) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('文章分析無法執行：缺少 ANTHROPIC_API_KEY');
  }

  const safeContent = typeof content === 'string' ? content : '';
  const truncatedContent = safeContent.slice(0, MAX_CONTENT_LENGTH);

  const prompt = buildPrompt(truncatedContent);

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
    throw new Error(`文章分析失敗：呼叫 Claude API 時發生錯誤（${detail}）`);
  }

  const textBlock = (response.content || []).find(
    (block) => block && block.type === 'text'
  );

  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error('文章分析失敗：模型回傳格式無法解析');
  }

  return parseAnalysisResponse(textBlock.text);
}

/**
 * AI 分析失敗時的備援標題判斷：優先找「標題：」標籤行，否則取第一個非空行(去除開頭 # )。
 * @param {string} content
 * @returns {string}
 */
function fallbackTitle(content) {
  const safeContent = typeof content === 'string' ? content : '';
  const lines = safeContent.split('\n');

  for (const line of lines) {
    const labelMatch = TITLE_LABEL_LINE_REGEX.exec(line);
    if (labelMatch) {
      return labelMatch[1].trim();
    }
  }

  for (const line of lines) {
    const plain = line.trim().replace(/^#+\s*/, '');
    if (plain) {
      return plain;
    }
  }

  return '未命名文章';
}

/**
 * 從貼稿內容中移除「等於標題」的那一行(標籤行如「標題：X」，或純文字/Markdown 標題的第一行)，
 * 避免文章標題在內文開頭重複出現一次。找不到相符的行時原樣回傳。
 * @param {string} content
 * @param {string} title
 * @returns {string}
 */
function stripTitleFromContent(content, title) {
  const safeContent = typeof content === 'string' ? content : '';
  const safeTitle = (typeof title === 'string' ? title : '').trim();
  if (!safeTitle) {
    return safeContent;
  }

  const lines = safeContent.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const labelMatch = TITLE_LABEL_LINE_REGEX.exec(line);
    if (labelMatch) {
      if (labelMatch[1].trim() === safeTitle) {
        lines.splice(i, 1);
        return lines.join('\n').replace(/^\n+/, '');
      }
      // 標籤行存在但標題不同：不是我們要找的行，繼續往下找。
      continue;
    }

    if (line.trim() === '') {
      continue;
    }

    // 第一個非空、非標籤的行：只有在它就是純標題文字時才視為標題行移除，
    // 否則代表內文最前面就是正文，不繼續往下找(避免誤刪內文中相同字串)。
    const plain = line.trim().replace(/^#+\s*/, '');
    if (plain === safeTitle) {
      lines.splice(i, 1);
      return lines.join('\n').replace(/^\n+/, '');
    }
    break;
  }

  return safeContent;
}

module.exports = {
  analyzeArticle,
  fallbackTitle,
  stripTitleFromContent,
};
