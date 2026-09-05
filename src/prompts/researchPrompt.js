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
//
// 可調整的 prompt 文字都獨立成 .md 文字檔，改文字檔即可、不用碰這支程式：
// - researchInstructions.md：第一段(搜尋)的人設與選題原則全文。
// - extractionInstructions.md：第二段(轉 JSON)的轉換規則全文。
// - categoryDefinitions.md：分類定義(兩段都會用到)。
// - eventDateRule.md：事件時間點欄位規則(兩段都會用到)。
// 這些檔案裡的 {{PLACEHOLDER}} 是唯一的動態插值點，由 render() 換成實際內容，
// 不要手動編輯 {{ }} 記號本身。

const fs = require('fs');
const path = require('path');

// 每次研究段要產出的候選則數(建議值，Gemini 不一定精確符合，實際以解析出的有效候選為準)。
const CANDIDATE_COUNT = 10;

// category 欄位的封閉清單——對應網站實際使用的分類，模型不得自創清單以外的名稱。
// 這裡跟 src/candidates.js、public/index.html 沒有耦合(那兩個只是把 category 當字串顯示)，
// 純粹是給 prompt 用的分類定義，之後網站分類調整只需要改這裡。
// 注意：這個陣列本身仍是程式碼(其他檔案會 require 它做驗證)，若要新增/刪除分類，
// 記得同時更新 categoryDefinitions.md 裡對應的定義文字，兩邊要一致。
const CATEGORIES = ['工藝', '影音', '文化', '歷史', '時事', '生活', '產業', '科技', '社會', '飲食', '永續'];

const CATEGORY_DEFINITIONS_TEMPLATE = fs.readFileSync(path.join(__dirname, 'categoryDefinitions.md'), 'utf8');
const EVENT_DATE_RULE = fs.readFileSync(path.join(__dirname, 'eventDateRule.md'), 'utf8');
const RESEARCH_INSTRUCTIONS = fs.readFileSync(path.join(__dirname, 'researchInstructions.md'), 'utf8');
const EXTRACTION_INSTRUCTIONS = fs.readFileSync(path.join(__dirname, 'extractionInstructions.md'), 'utf8');

// 分類定義區塊：研究(第一段)跟轉換(第二段)都會用到，只維護一份避免兩段定義不一致。
const CATEGORY_DEFINITIONS = render(CATEGORY_DEFINITIONS_TEMPLATE, { CATEGORY_COUNT: CATEGORIES.length });

/**
 * 把樣板文字裡的 {{KEY}} 換成對應值。
 * @param {string} template
 * @param {Object<string,string>} vars
 * @returns {string}
 */
function render(template, vars) {
  return Object.keys(vars).reduce(
    (text, key) => text.split(`{{${key}}}`).join(vars[key]),
    template,
  );
}

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

  return render(RESEARCH_INSTRUCTIONS, {
    COUNT: String(n),
    DEDUP_BLOCK: buildDedupBlock(dedupTitles),
    CATEGORY_DEFINITIONS,
    CATEGORY_COUNT: String(CATEGORIES.length),
    EVENT_DATE_RULE,
  });
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
  return render(EXTRACTION_INSTRUCTIONS, {
    CATEGORY_COUNT: String(CATEGORIES.length),
    CATEGORIES_JOINED: CATEGORIES.join('、'),
    EVENT_DATE_RULE,
    CATEGORY_DEFINITIONS,
    REPORT_TEXT: reportText,
  });
}

module.exports = {
  CANDIDATE_COUNT,
  CATEGORIES,
  EVENT_DATE_RULE,
  buildResearchPrompt,
  buildExtractionPrompt,
};
