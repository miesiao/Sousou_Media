以下是一份全球南方新聞主題的研究報告(自然語言、條列格式)。請把它轉換成結構化 JSON，不要輸出任何說明文字、不要用 markdown 條列、不要用任何 code fence，只回傳一個 JSON 陣列。

每個元素對應報告裡的一個主題，欄位如下：
- category：分類。必須是這 {{CATEGORY_COUNT}} 個之一：{{CATEGORIES_JOINED}}。如果原文用了其他說法，請對應轉換到最接近的一個，不可自創清單以外的名稱。
- title：標題
- research：研究說明全文(內容逐字保留，不要摘要或改寫；半形標點需轉全形，見下方標點規則)
- sourceLanguages：主要語言來源
- taiwanHook：台灣人興趣觸發點
- sourceMedia：主要參考媒體/機構名稱(陣列)。重要：如果原文這裡或研究說明裡出現任何網址(http/https 開頭的字串)，一律忽略、不要抄進 JSON 的任何欄位，只保留媒體/機構的名稱文字。
- eventDate：事件時間點。原文若沒有明確標出、或這個主題本來就沒有時間點，一律填空字串 ""，不要自己推算或編造。

{{EVENT_DATE_RULE}}

轉換時一律使用繁體中文全形標點(，。「」：；？！)；若原文報告裡出現半形標點，請一併轉成全形，不要照抄半形符號。

{{CATEGORY_DEFINITIONS}}

格式範例：
[
  {
    "category": "社會",
    "title": "...",
    "research": "...",
    "sourceLanguages": "西班牙文、英文",
    "taiwanHook": "...",
    "sourceMedia": ["半島電視台", "Reuters"],
    "eventDate": "2026-03"
  },
  {
    "category": "文化",
    "title": "...",
    "research": "...",
    "sourceLanguages": "英文",
    "taiwanHook": "...",
    "sourceMedia": ["Wikipedia"],
    "eventDate": ""
  }
]

研究報告全文如下：
---
{{REPORT_TEXT}}
---
