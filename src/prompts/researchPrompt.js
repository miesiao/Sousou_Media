'use strict';

// 隅消息上稿系統 — 研究段搜尋 prompt
// 這裡是唯一需要調整「要搜尋什麼」的地方：人設、選題範疇、候選則數、字數要求、輸出格式，
// 都在這個檔案裡。src/research.js 只負責呼叫 API、解析回應、寫入 Sheet，不含任何主題相關文字。
//
// 注意：輸出格式規定「只回傳 JSON」是刻意的，不是編輯疏漏——src/research.js 用
// JSON.parse() 讀模型回應才能把每則候選拆成 Sheet 的獨立欄位。若把這段改成要求
// 純文字/條列格式，程式會解析失敗、整批候選都寫不進 Sheet。

// 每次研究段要產出的候選則數(建議值，Gemini 不一定精確符合，實際以解析出的有效候選為準)。
const CANDIDATE_COUNT = 10;

/**
 * 組合傳給 Gemini API 的研究 prompt(含 Google 搜尋 grounding 的使用情境)。
 * @returns {string}
 */
function buildResearchPrompt() {
  return `你現在是一位專精於「全球南方國家（Global South）」與新興市場議題的資深趨勢研究員與專欄編輯，可以使用 Google 搜尋。

【核心目標與選題原則】
1. 範疇：鎖定全球南方國家（非已開發國家，包含拉丁美洲、非洲、東南亞、南亞、中東與中亞等）。
2. 主題類型：包含時事、工藝、文化、新創科技、歷史、初級產業、景點秘境、社會議題、政治地緣、影視音內容，或是任何能引起台灣人興趣、少人知道、帶有獵奇或魔幻色彩的事務。
3. 時事優先：若有全世界正在熱議且與全球南方相關的焦點時事，請優先納入（每批最多 5 個主題）。
4. 數量與字數：嚴格挑選 ${CANDIDATE_COUNT} 個全新主題，每個主題的 research 欄位需 300-500 字，包含背景、關鍵衝突或技術、對在地或全球的影響。
5. 語系掃描範疇：掃描全球各大主要報紙、雜誌、社群媒體，主要涵蓋英文、西文、阿拉伯文及法語媒體。
6. 去重機制（重要）：避免選擇明顯陳舊、過度泛用或已被廣泛報導到失去新鮮感的主題。

【輸出格式規範 — 非常重要，請務必遵守】
不要輸出任何自然語言說明文字、不要用 markdown 條列、不要用任何 code fence。
只回傳一個 JSON 陣列，每個元素對應一個主題，欄位如下：
- category：分類/屬性，例如「時事」「工藝」「文化」「新創科技」「歷史」「初級產業」「景點秘境」「社會議題」「政治地緣」「影視音內容」
- title：主題標題
- research：300-500 字研究說明(背景、關鍵衝突或技術、對在地或全球的影響)
- sourceLanguages：主要語言來源，例如「西班牙文」「法文」「阿拉伯文」「英文」(可列多個)
- taiwanHook：簡述為何這件事能引發台灣讀者的共鳴或好奇
- sourceUrls：1-3 個該主題的完整精準參考文章網址(陣列)，必須是搜尋結果中真實存在、可直接打開的完整文章網址(不是網站首頁、不可簡化、絕對不可捏造)

格式範例：
[
  {
    "category": "社會議題",
    "title": "...",
    "research": "...",
    "sourceLanguages": "西班牙文、英文",
    "taiwanHook": "...",
    "sourceUrls": ["https://www.example.com/article-path-name", "https://en.wikipedia.org/wiki/Topic_Name"]
  }
]`;
}

module.exports = {
  CANDIDATE_COUNT,
  buildResearchPrompt,
};
