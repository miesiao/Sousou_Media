'use strict';

// 隅消息上稿系統 — 研究段搜尋 prompt
// 這裡是唯一需要調整「要搜尋什麼」的地方：人設、選題範疇、候選則數、字數要求、分類定義，
// 都在這個檔案裡。src/research.js 只負責呼叫 API、解析回應、寫入 Sheet，不含任何主題相關文字。
//
// 為什麼拆成兩段 prompt(重要，改這個檔案前請先讀完)：
// 實測發現 Gemini 只要 prompt 要求「只回傳 JSON、不要有任何說明文字」，就完全不會觸發
// Google 搜尋 grounding(candidate.groundingMetadata 整個消失，等於没有真的搜尋，模型直接
// 憑訓練記憶編造內容)；反之若允許自然語言回答，grounding 就正常運作。同時 Gemini API 本身
// 也不允許 tools(google_search) 跟 generationConfig.responseMimeType=application/json 同時
// 使用(會直接回傳空結果，無 candidates)。所以無法一次呼叫就同時「有真的搜尋」又「輸出乾淨JSON」。
//
// 因此設計成兩段：
// 1. buildResearchPrompt()：自然語言、開 google_search 工具，真正觸發搜尋，換得可信的
//    groundingMetadata(真實來源網址的唯一依據)。
// 2. buildExtractionPrompt(reportText)：把第 1 段的自然語言報告餵回去，這次不開搜尋工具，
//    純粹要求轉成結構化 JSON——這一步沒有搜尋工具，所以強制 JSON 輸出不會有副作用。
// 兩段各自呼叫 Gemini，src/research.js 負責串起來。

// 每次研究段要產出的候選則數(建議值，Gemini 不一定精確符合，實際以解析出的有效候選為準)。
const CANDIDATE_COUNT = 10;

// category 欄位的封閉清單——對應網站實際使用的分類，模型不得自創清單以外的名稱。
// 這裡跟 src/candidates.js、public/index.html 沒有耦合(那兩個只是把 category 當字串顯示)，
// 純粹是給 prompt 用的分類定義，之後網站分類調整只需要改這裡。
const CATEGORIES = ['工藝', '影音', '文化', '歷史', '時事', '生活', '產業', '科技', '社會', '飲食', '永續'];

// 分類定義區塊：研究(第一段)跟轉換(第二段)都會用到，只維護一份避免兩段定義不一致。
const CATEGORY_DEFINITIONS = `【分類定義 — category 只能是以下 ${CATEGORIES.length} 個之一，不得自創清單以外的分類名稱】
- 工藝：傳統手工技藝、職人技術、材料與工法、工藝復振
- 影音：電影、電視、音樂、串流內容、影展、當地流行文化產出
- 文化：現今仍在運作的民俗、信仰、節慶、語言、藝術與生活儀式
- 歷史：已成過去的事件與脈絡，含古文明、考古發現、殖民歷史與遺緒、獨立運動、被遺忘的歷史人物與事件
- 時事：近期（約一個月內）實際發生、有明確事件與時間點的新聞
- 生活：日常生活樣貌、居住、交通、消費習慣，以及旅遊景點與秘境
- 產業：農林漁牧礦等初級產業、製造業、在地商業模式與貿易
- 科技：技術創新與數位服務，特別是南方國家自己發展出的解決方案（如行動支付、數位身分、低成本醫療器材）、新創、科研與太空計畫
- 社會：長期存在的結構性議題（族群、性別、階級、移工、教育、公衛、地緣政治的社會面向等）。重點在「長久以來如此、只是還沒被介紹給台灣讀者」，不依附於單一新聞事件，也不需要有時效性
- 飲食：在地食材、料理與飲食文化、餐飲產業、農食供應鏈
- 永續：氣候變遷衝擊、能源轉型、資源開採與環境正義、生態保育

容易混淆的界線：
- 文化 vs 歷史：現在仍在進行、活著的實踐歸「文化」；已經結束、屬於過去的事件與脈絡歸「歷史」。
- 產業 vs 科技：農礦製造、供應鏈、商業模式歸「產業」；技術創新、數位服務、新創與科研歸「科技」。
- 時事 vs 社會（會影響配額，很重要）：只有具備明確事件與時間點的才算「時事」並計入時事配額；結構性、長期性的議題一律歸「社會」，不佔用時事配額。`;

/**
 * 組出「避免重複」區塊：把既有題目清單(只有標題文字)塞進 prompt，要求模型不得產出
 * 重複或高度相似的主題。清單本身的篩選/去重/上限規則在 src/candidates.js 的
 * buildDedupTitleList()，這裡只負責把清單轉成 prompt 文字。
 * @param {string[]} [dedupTitles]
 * @returns {string}
 */
function buildDedupBlock(dedupTitles) {
  const titles = Array.isArray(dedupTitles) ? dedupTitles.filter(Boolean) : [];
  if (titles.length === 0) return '';

  return `\n【避免重複 — 已存在的候選題目清單】以下是近期已經產出過的候選題目標題，不得產出與下列任何一則重複或高度相似的題目：\n${titles.map((t) => `- ${t}`).join('\n')}\n`;
}

/**
 * 第一段：自然語言研究 prompt(開 Google 搜尋 grounding)。
 * 刻意不要求 JSON——強制 JSON 會讓 Gemini 不觸發搜尋，詳見檔案開頭說明。
 * @param {number} [count] 要求產出的候選則數，預設 CANDIDATE_COUNT
 * @param {string[]} [dedupTitles] 既有題目標題清單(供避開重複)，見 buildDedupBlock
 * @returns {string}
 */
function buildResearchPrompt(count, dedupTitles) {
  const n = Number.isInteger(count) && count > 0 ? count : CANDIDATE_COUNT;

  return `你現在是一位專精於「全球南方國家（Global South）」與新興市場議題的資深趨勢研究員與專欄編輯，可以使用 Google 搜尋。請實際使用 Google 搜尋查證以下每一個主題的最新資訊，不要只憑內部知識回答。

【核心目標與選題原則】
1. 範疇：鎖定全球南方國家（非已開發國家，包含拉丁美洲、非洲、東南亞、南亞、中東與中亞等）。
2. 主題類型：包含時事、工藝、文化、科技與新創、歷史、初級產業、生活樣貌與景點秘境、社會結構性議題、飲食文化與在地食材、氣候變遷與環境正義、資源開採、生態保育、影視音內容，或是任何能引起台灣人興趣、少人知道、帶有獵奇或魔幻色彩的事務。
3. 時事優先：若有全世界正在熱議且與全球南方相關的焦點時事，請優先納入（每批最多 5 個屬於「時事」分類的主題——注意「時事」跟「社會」的區別，見下方分類定義）。
4. 數量與字數：嚴格挑選 ${n} 個全新主題，每個主題的研究說明需 300-500 字，包含背景、關鍵衝突或技術、對在地或全球的影響。
5. 語系掃描範疇：掃描全球各大主要報紙、雜誌、社群媒體，主要涵蓋英文、西文、阿拉伯文及法語媒體。
6. 去重機制（重要）：避免選擇明顯陳舊、過度泛用或已被廣泛報導到失去新鮮感的主題。
${buildDedupBlock(dedupTitles)}
${CATEGORY_DEFINITIONS}

【回答格式】用自然語言、依序條列每一個主題即可，每個主題請包含以下欄位(用你覺得清楚的方式標示欄位名稱)：
- 分類(必須是上面 11 個分類之一，不可自創其他名稱)
- 標題
- 研究說明(300-500 字)
- 主要語言來源(例如：西班牙文、法文、阿拉伯文、英文)
- 台灣人興趣觸發點(簡述為何這件事能引發台灣讀者的共鳴或好奇)
- 主要參考媒體/機構名稱(1-3 個，例如：中央社、BBC、半島電視台、Wikipedia。只需要列出名稱，不需要附網址)

不需要輸出 JSON 或任何程式碼格式，用一般文字條列回答即可。`;
}

/**
 * 第二段：把第一段的自然語言研究報告轉成結構化 JSON(不開搜尋工具)。
 * 明確要求忽略原文裡出現的任何網址——sourceMedia 只保留媒體/機構名稱文字，
 * 真正的參考連結由 src/research.js 另外從 groundingMetadata 解析取得，
 * 不能信任模型在轉換過程中重新打出來的網址。
 * category 這裡也重申一次封閉清單，避免第一段用詞跑掉時，轉換階段沒有機會收斂回來。
 * @param {string} reportText 第一段(buildResearchPrompt)產出的自然語言報告全文
 * @returns {string}
 */
function buildExtractionPrompt(reportText) {
  return `以下是一份全球南方新聞主題的研究報告(自然語言、條列格式)。請把它轉換成結構化 JSON，不要輸出任何說明文字、不要用 markdown 條列、不要用任何 code fence，只回傳一個 JSON 陣列。

每個元素對應報告裡的一個主題，欄位如下：
- category：分類。必須是這 ${CATEGORIES.length} 個之一：${CATEGORIES.join('、')}。如果原文用了其他說法，請對應轉換到最接近的一個，不可自創清單以外的名稱。
- title：標題
- research：研究說明全文(逐字保留，不要摘要或改寫)
- sourceLanguages：主要語言來源
- taiwanHook：台灣人興趣觸發點
- sourceMedia：主要參考媒體/機構名稱(陣列)。重要：如果原文這裡或研究說明裡出現任何網址(http/https 開頭的字串)，一律忽略、不要抄進 JSON 的任何欄位，只保留媒體/機構的名稱文字。

${CATEGORY_DEFINITIONS}

格式範例：
[
  {
    "category": "社會",
    "title": "...",
    "research": "...",
    "sourceLanguages": "西班牙文、英文",
    "taiwanHook": "...",
    "sourceMedia": ["半島電視台", "Reuters"]
  }
]

研究報告全文如下：
---
${reportText}
---`;
}

module.exports = {
  CANDIDATE_COUNT,
  CATEGORIES,
  buildResearchPrompt,
  buildExtractionPrompt,
};
