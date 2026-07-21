'use strict';

// 隅消息上稿系統 — 研究段搜尋 prompt
// 這裡是唯一需要調整「要搜尋什麼」的地方：主題定義、候選則數、摘要長度、輸出格式要求，
// 都在這個檔案裡。src/research.js 只負責呼叫 API 跟寫入 Sheet，不含任何主題相關文字。

// 每次研究段要產出的候選則數(建議值，Gemini 不一定精確符合，實際以解析出的有效候選為準)。
const CANDIDATE_COUNT = 10;

// TODO：這裡先放一個籠統的預設定義，正式使用前請換成你實際想要的「南方」主題範圍
// (例如：特定地區、特定關注角度、要不要排除某些媒體來源等)。
const TOPIC_DESCRIPTION = `「南方」相關的最新新聞素材(全球南方 Global South 國家/地區的政治、經濟、社會議題)。
請在這裡具體換成你實際想要的主題定義，例如聚焦哪些國家或地區、哪些角度、哪些媒體來源。`;

/**
 * 組合傳給 Gemini API 的研究 prompt(含 Google 搜尋 grounding 的使用情境)。
 * @returns {string}
 */
function buildResearchPrompt() {
  return `你是新聞編輯的研究助理，可以使用 Google 搜尋。請找出過去 7 天內、跟以下主題相關、
足夠新鮮且有具體來源可查證的新聞素材，總共約 ${CANDIDATE_COUNT} 則。

主題範圍：
${TOPIC_DESCRIPTION}

每一則請包含：
- title：建議的中文候選標題(不是原新聞標題，是給編輯參考用的候選標題)
- summary：2-3 句中文摘要，說明這則新聞在講什麼、為什麼值得寫成文章
- keywords：3-5 個關鍵字(陣列，中文或英文皆可)
- sourceUrl：這則新聞素材的實際參考連結(必須是搜尋結果中真實存在的網址，絕對不可捏造)

請只回傳一個 JSON 陣列，不要有任何說明文字、不要用 markdown code fence 包起來，格式如下：
[
  {"title": "...", "summary": "...", "keywords": ["...", "..."], "sourceUrl": "https://..."}
]`;
}

module.exports = {
  CANDIDATE_COUNT,
  buildResearchPrompt,
};
