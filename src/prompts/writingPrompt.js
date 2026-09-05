'use strict';

// 隅消息上稿系統 — 撰寫段生成 prompt
// 這裡是唯一需要調整「怎麼寫」的地方：人設、風格依據、寫作規則、事實查證、圖說格式、
// 輸出格式，都在這個檔案裡。src/writing.js 只負責呼叫 API、解析回應、寫入 Sheet，
// 不含任何主題/風格相關文字。
//
// 風格依據來自兩份隨附文件(生成時整份放進系統提示，不摘要、不省略)：
// - styleGuide.md：南南之隅風格指南全文。
// - examples.md：三篇範例文全文(已移除網址／發布日期／作者三行，保留標題/分類/標籤)。

const fs = require('fs');
const path = require('path');

const STYLE_GUIDE = fs.readFileSync(path.join(__dirname, 'styleGuide.md'), 'utf8');
const EXAMPLES = fs.readFileSync(path.join(__dirname, 'examples.md'), 'utf8');
// 寫作規則、事實查證、圖說格式、輸出格式——獨立成文字檔，方便持續調整而不用改這支程式。
// {{CATEGORIES}} 是唯一的動態插值點，組 prompt 時換成 CATEGORIES 清單。
const WRITING_RULES = fs.readFileSync(path.join(__dirname, 'writingRules.md'), 'utf8');

// 建議分類的封閉清單——對應網站實際使用的分類(含「隅」字首)，模型不得自創清單以外的名稱。
// 注意「社會」類正確寫法是「隅社會」，不是「隕社會」。
const CATEGORIES = [
  '隅工藝', '隅影音', '隅文化', '隅歷史', '隅時事',
  '隅生活', '隅產業', '隅科技', '隅社會', '隅飲食', '隅永續',
];

/**
 * 系統提示：人設、風格依據(全文附上)、寫作規則、事實查證、圖說、輸出格式。
 * 跟候選題目資料無關，同一次撰寫段呼叫(Claude / Gemini)共用同一份。
 * @returns {string}
 */
function buildWritingSystemPrompt() {
  return `你是「南南之隅」(Sousou Corner)的資深撰稿編輯，專精全球南方國家與各國的文化、工藝、歷史、生活、時事、產業、科技、影視音內容。你的任務是依據編輯提供的候選題目資料，撰寫一篇可直接刊登的完整文章初稿。

【風格依據 — 務必嚴格遵守，這是品質核心，不可省略或摘要】
以下附上完整的風格指南全文與三篇範例文全文。寫作時嚴格遵守風格指南訂下的規則，並模仿範例文的語氣、節奏與結構。寧可寫得像範例文，也不要寫成泛用網路文體或 AI 腔。

===== 風格指南全文 開始 =====
${STYLE_GUIDE}
===== 風格指南全文 結束 =====

===== 範例文全文（三篇） 開始 =====
${EXAMPLES}
===== 範例文全文（三篇） 結束 =====

${WRITING_RULES.replace('{{CATEGORIES}}', CATEGORIES.join('、'))}`;
}

/**
 * 使用者提示：帶入單一候選題目的資料(題目、分類、研究說明、主要語言來源、
 * 台灣人興趣觸發點、事件時間點、參考資料的媒體名)。參考資料只給媒體名稱，不給網址。
 * @param {{title:string, category?:string, research?:string, sourceLanguages?:string, taiwanHook?:string, eventDate?:string, mediaNames?:string[]}} input
 * @returns {string}
 */
function buildWritingUserPrompt(input) {
  const title = (input && input.title) || '';
  const category = (input && input.category) || '(未分類)';
  const research = (input && input.research) || '(無研究說明)';
  const sourceLanguages = (input && input.sourceLanguages) || '(未標示)';
  const taiwanHook = (input && input.taiwanHook) || '(未標示)';
  const eventDate = (input && input.eventDate) || '';
  const mediaNames = Array.isArray(input && input.mediaNames) ? input.mediaNames.filter(Boolean) : [];
  const mediaText = mediaNames.length > 0 ? mediaNames.join('、') : '(無參考媒體資訊)';

  // eventDate 只在研究段有把握判斷出時才會有值(沒有把握就留空，不是模型自己算的)，
  // 有值時直接把這個時間點交給撰寫模型引用，不要讓它自己重新推算或憑印象編造年份。
  const eventDateBlock = eventDate
    ? `\n【事件時間點(已查證，行文可直接引用，不要自己另外推算)】${eventDate}\n`
    : '';

  return `請依據以下候選題目資料，撰寫一篇完整文章初稿：

【候選題目】${title}
【研究段建議分類】${category}
【研究說明】
${research}

【主要語言來源】${sourceLanguages}
【台灣人興趣觸發點】${taiwanHook}
${eventDateBlock}【參考資料媒體名稱】${mediaText}

請直接輸出符合上述系統提示規定格式的完整成品，不要輸出任何說明文字。`;
}

module.exports = {
  CATEGORIES,
  buildWritingSystemPrompt,
  buildWritingUserPrompt,
};
