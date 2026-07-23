'use strict';

// 隅消息上稿系統 — grounding 來源解析、媒體/內容比對
// 處理 Gemini Google 搜尋 grounding 回傳的 groundingChunks：
// 1. 解開 vertexaisearch.cloud.google.com 開頭的重導向連結(有使用期限，不能直接存)，
//    取得真正可長期保存的來源網址，順便抓回頁面 <title>。
// 2. 把每個來源分配給正確的候選，比對層級由高到低：
//    (a) 內容比對：用文章標題跟候選主題的語意相關性判斷(呼叫端另外用 Gemini 做，
//        這裡只負責組 prompt 跟解析回應)。
//    (b) 媒體名稱比對：candidate 自己宣稱的 sourceMedia 跟來源的 hostname/title/domain
//        寬鬆比對；同一媒體名同時比對到 2 筆以上來源時標記為不確定，不能悄悄全部塞入。
//    (c) 備援清單：都比對不到時，列出整批來源供人工查證，不因此丟棄候選。
// 這裡的比對規則刻意寬鬆，且不求完美——不確定的地方一定要讓使用者看得出來，不能悄悄選錯。

const REDIRECT_TIMEOUT_MS = 8000;
const REDIRECT_CONCURRENCY = 5;
// 只讀取頁面前面這麼多 bytes 去找 <title>，不需要整頁下載完。
const MAX_TITLE_FETCH_BYTES = 100 * 1024;

// 常見媒體/機構的中文慣用名 → 官方網域，用於比對(不求完整，之後遇到新的可以再加)。
// 只需要收「名稱跟網域幾乎不共享字元」的類型(中文通訊社、機構縮寫等)；
// 英文媒體名稱通常跟網域本身就高度重疊(例如 Reuters/reuters.com)，靠下面的正規化字串
// 互相包含比對就找得到，不需要特別列出來。
const MEDIA_DOMAIN_ALIASES = {
  中央社: 'cna.com.tw',
  cna: 'cna.com.tw',
  半島電視台: 'aljazeera.com',
  半岛电视台: 'aljazeera.com',
  半島英文台: 'aljazeera.com',
  aljazeera: 'aljazeera.com',
  路透: 'reuters.com',
  路透社: 'reuters.com',
  reuters: 'reuters.com',
  美聯社: 'apnews.com',
  美联社: 'apnews.com',
  衛報: 'theguardian.com',
  卫报: 'theguardian.com',
  guardian: 'theguardian.com',
  紐約時報: 'nytimes.com',
  纽约时报: 'nytimes.com',
  nyt: 'nytimes.com',
  華盛頓郵報: 'washingtonpost.com',
  华盛顿邮报: 'washingtonpost.com',
  維基百科: 'wikipedia.org',
  维基百科: 'wikipedia.org',
  wikipedia: 'wikipedia.org',
  新華社: 'news.cn',
  新华社: 'news.cn',
  xinhua: 'news.cn',
  法新社: 'afp.com',
  afp: 'afp.com',
  聯合國: 'un.org',
  联合国: 'un.org',
  世界銀行: 'worldbank.org',
  世界银行: 'worldbank.org',
};

/**
 * 從 groundingMetadata 取出每個來源(web.uri / web.title / web.domain)。
 * @param {object|null|undefined} groundingMetadata Gemini API 回應 candidate.groundingMetadata
 * @returns {Array<{uri: string, title: string, domain: string}>}
 */
function extractGroundingSources(groundingMetadata) {
  const chunks = (groundingMetadata && groundingMetadata.groundingChunks) || [];
  const sources = [];

  for (const chunk of chunks) {
    const web = chunk && chunk.web;
    if (!web || typeof web.uri !== 'string' || web.uri.trim() === '') continue;
    sources.push({
      uri: web.uri,
      title: typeof web.title === 'string' ? web.title : '',
      domain: typeof web.domain === 'string' ? web.domain : '',
    });
  }

  return sources;
}

/**
 * 解碼常見 HTML entities(只處理 <title> 擷取會遇到的基本情況，不求完整)。
 * @param {string} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * 從 ReadableStream 邊讀邊找 <title>...</title>，找到就停止(不用整頁讀完)；
 * 讀滿 maxBytes 還沒找到、或串流結束都回傳 null(找不到標題)。
 * @param {ReadableStream} body
 * @param {number} maxBytes
 * @returns {Promise<string|null>}
 */
async function readTitleFromBody(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;

      const partial = Buffer.concat(chunks).toString('utf8');
      const match = partial.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (match) {
        // 有些頁面的 <title> 內含換行/多個空白(排版用)，收斂成單一空白避免 Sheet 裡顯示凌亂。
        const title = decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim();
        return title || null;
      }

      if (received >= maxBytes) break;
    }
  } catch (err) {
    // 讀取中斷(逾時/連線中斷)一律視為找不到標題，不 throw。
  } finally {
    try {
      await reader.cancel();
    } catch (err) {
      // 忽略取消時的錯誤。
    }
  }

  return null;
}

/**
 * 跟隨重導向解開單一 grounding 來源網址，並嘗試抓取頁面 <title>。
 * 解不開(逾時/網路錯誤/任何例外)一律退回原始 uri、標題設為 null，不讓整批解析失敗；
 * 抓不到標題(403、非 HTML、逾時)也保留網址，不因此丟棄該來源。
 * @param {string} uri
 * @returns {Promise<{resolvedUri: string, pageTitle: string|null}>}
 */
async function resolveRedirectUrl(uri) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIRECT_TIMEOUT_MS);

  try {
    const response = await fetch(uri, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });

    const resolvedUri = response.url || uri;
    const contentType = response.headers.get('content-type') || '';

    let pageTitle = null;
    if (response.body && /text\/html/i.test(contentType)) {
      pageTitle = await readTitleFromBody(response.body, MAX_TITLE_FETCH_BYTES);
    } else if (response.body && typeof response.body.cancel === 'function') {
      response.body.cancel().catch(() => {});
    }

    return { resolvedUri, pageTitle };
  } catch (err) {
    return { resolvedUri: uri, pageTitle: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 併發解開多個來源網址(同時最多 REDIRECT_CONCURRENCY 個)，回傳與輸入同順序的結果陣列。
 * @param {Array<{uri: string}>} sources
 * @returns {Promise<Array<{resolvedUri: string, pageTitle: string|null}>>}
 */
async function resolveAllRedirects(sources) {
  const resolved = new Array(sources.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= sources.length) return;
      resolved[i] = await resolveRedirectUrl(sources[i].uri);
    }
  }

  const workerCount = Math.min(REDIRECT_CONCURRENCY, sources.length) || 0;
  await Promise.all(Array.from({ length: workerCount }, worker));

  return resolved;
}

/**
 * 從網址取出去掉開頭 www. 的 hostname，解析失敗回傳空字串。
 * @param {string} url
 * @returns {string}
 */
function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (err) {
    return '';
  }
}

/**
 * 正規化字串供寬鬆比對用：轉小寫、去掉協定/www、只留英數字與中日韓文字元。
 * @param {string} str
 * @returns {string}
 */
function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9一-鿿]/g, '');
}

/**
 * 判斷媒體名稱是否(寬鬆規則)對應到某個 grounding 來源：
 * 對照表命中，或正規化後字串互相包含(對 hostname / title / domain 任一個)。
 * @param {string} mediaName
 * @param {{hostname: string, title: string, domain: string}} source
 * @returns {boolean}
 */
function mediaMatchesSource(mediaName, source) {
  const normMedia = normalizeForMatch(mediaName);
  if (!normMedia) return false;

  const normHostname = normalizeForMatch(source.hostname);
  const normTitle = normalizeForMatch(source.title);
  const normDomain = normalizeForMatch(source.domain);

  const alias = MEDIA_DOMAIN_ALIASES[normMedia];
  if (alias && normHostname && normHostname.includes(normalizeForMatch(alias))) {
    return true;
  }

  if (normHostname) {
    const hostRoot = normHostname.split('.')[0];
    if (normHostname.includes(normMedia) || (hostRoot && normMedia.includes(hostRoot))) {
      return true;
    }
  }
  if (normTitle && (normTitle.includes(normMedia) || normMedia.includes(normTitle))) {
    return true;
  }
  if (normDomain && (normDomain.includes(normMedia) || normMedia.includes(normDomain))) {
    return true;
  }

  return false;
}

/**
 * 格式化單一來源為一行文字：有文章標題就「標籤：文章標題 網址」，沒有就「標籤：網址」。
 * @param {{resolvedUri: string, pageTitle: string|null}} source
 * @param {string} label 顯示用標籤(媒體名稱或來源自己的 title/hostname)
 * @returns {string}
 */
function formatSourceLine(source, label) {
  const safeLabel = label || source.title || source.hostname || '來源';
  if (source.pageTitle) {
    return `${safeLabel}：${source.pageTitle} ${source.resolvedUri}`;
  }
  return `${safeLabel}：${source.resolvedUri}`;
}

/**
 * 第二層(媒體名稱比對)：在「可用來源」(尚未被內容比對認領走的來源)裡，依 item.sourceMedia
 * 逐一寬鬆比對。同一媒體名比對到 1 筆 → 採用並標記「(僅媒體名比對)」；比對到 2 筆以上 →
 * 標記為不確定，列出全部候選網址讓人工確認，不悄悄只挑一個或全部塞入當作已確認。
 * @param {{sourceMedia: string[]}} item
 * @param {Array<object>} availableSources 尚未被內容比對認領的來源
 * @returns {string|null} 沒有任何比對得到時回傳 null(呼叫端應改用備援清單)
 */
function buildMediaMatchText(item, availableSources) {
  const lines = [];
  const usedUrls = new Set();

  for (const mediaName of item.sourceMedia) {
    const matches = availableSources.filter(
      (source) => !usedUrls.has(source.resolvedUri) && mediaMatchesSource(mediaName, source)
    );

    if (matches.length === 0) continue;

    if (matches.length === 1) {
      usedUrls.add(matches[0].resolvedUri);
      lines.push(`${formatSourceLine(matches[0], mediaName)}(僅媒體名比對)`);
    } else {
      matches.forEach((m) => usedUrls.add(m.resolvedUri));
      lines.push(`${mediaName}（比對到 ${matches.length} 筆，需人工確認）：`);
      matches.forEach((m) => lines.push('  - ' + formatSourceLine(m, mediaName)));
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

// 備援清單最多列幾筆——避免同批次來源一多，每則比對不到的候選都塞進整批，變得又長又雜訊。
// 只是給人工一個查證起點，不是要窮舉，所以刻意收斂在小數字。
const MAX_FALLBACK_SOURCES = 4;

/**
 * 第三層(備援清單)：完全比對不到來源時，標記「來源未比對到」+ 模型宣稱的媒體名稱，
 * 並附上「尚未被其他候選認領走」的來源(最多 MAX_FALLBACK_SOURCES 筆)供人工查證起點，
 * 不因為比對不到就丟掉這則候選——但也不塞整批未過濾的來源進去，避免每一則備援看起來都一樣長。
 * @param {{sourceMedia: string[]}} item
 * @param {Array<object>} availableSources 尚未被內容比對認領的來源(跟 buildMediaMatchText 用同一份)
 * @returns {string}
 */
function buildFallbackText(item, availableSources) {
  const mediaList = item.sourceMedia.length ? item.sourceMedia.join('、') : '(模型未提供媒體名稱)';

  if (availableSources.length === 0) {
    return `來源未比對到，請人工查證(模型宣稱來源：${mediaList})：(本批次沒有其他可查證的來源)`;
  }

  const shown = availableSources.slice(0, MAX_FALLBACK_SOURCES);
  const lines = shown.map((source) => formatSourceLine(source, source.title || source.hostname));
  return `來源未比對到，請人工查證(模型宣稱來源：${mediaList})：\n${lines.join('\n')}`;
}

/**
 * 組出「內容比對」用的 prompt：把候選清單跟來源清單都列出來，請 Gemini 依內容相關性
 * 判斷每個來源屬於哪一則候選(跨語言比對，候選是中文、來源標題可能是英西法阿等語言)。
 * @param {Array<{title: string, research: string, taiwanHook: string}>} items
 * @param {Array<{title: string, hostname: string, pageTitle: string|null}>} sources
 * @returns {string}
 */
function buildContentMatchPrompt(items, sources) {
  const candidateList = items.map((item, i) => ({
    id: i,
    title: item.title,
    summary: (item.research || item.taiwanHook || '').slice(0, 80),
  }));

  const sourceList = sources.map((source, i) => ({
    id: i,
    media: source.title || source.hostname || '',
    pageTitle: source.pageTitle || null,
  }));

  return `你要幫忙把「搜尋來源」正確分配給「候選題目」，判斷依據是內容主題的相關性，不是語言或媒體名稱是否相同。這是跨語言比對：候選題目是中文，來源的文章標題可能是英文、西班牙文、法文、阿拉伯文等，請用主題內容判斷。

候選題目清單(id / 標題 / 摘要)：
${JSON.stringify(candidateList)}

搜尋來源清單(id / 媒體名稱 / 文章標題，部分來源沒有文章標題(pageTitle 為 null)，這種請盡量憑媒體名稱推測，若無法判斷歸屬就設為 null)：
${JSON.stringify(sourceList)}

請針對每一個來源，判斷它的內容最符合哪一個候選的 id；如果內容跟任何候選都無關、或無法判斷，回傳 null。
只回傳一個 JSON 陣列，不要有任何說明文字、不要用 markdown 條列、不要用任何 code fence，格式如下：
[{"sourceId": 0, "candidateId": 2}, {"sourceId": 1, "candidateId": null}]`;
}

/**
 * 解析「內容比對」呼叫的回應，回傳 sourceIndex → candidateIndex 的對照(Map)。
 * 格式不符、缺欄位、id 超出範圍的項目一律忽略(不影響其他項目)。
 * @param {string} rawText
 * @param {number} sourceCount
 * @param {number} itemCount
 * @returns {Map<number, number>}
 */
function parseContentMatchResponse(rawText, sourceCount, itemCount) {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : trimmed;

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('內容比對回應無法解析為 JSON：' + (err && err.message));
  }

  if (!Array.isArray(parsed)) {
    throw new Error('內容比對回應格式不是陣列');
  }

  const map = new Map();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const sourceId = entry.sourceId;
    const candidateId = entry.candidateId;
    if (!Number.isInteger(sourceId) || sourceId < 0 || sourceId >= sourceCount) continue;
    if (candidateId === null || candidateId === undefined) continue;
    if (!Number.isInteger(candidateId) || candidateId < 0 || candidateId >= itemCount) continue;
    map.set(sourceId, candidateId);
  }

  return map;
}

module.exports = {
  MEDIA_DOMAIN_ALIASES,
  extractGroundingSources,
  resolveRedirectUrl,
  resolveAllRedirects,
  hostnameFromUrl,
  normalizeForMatch,
  mediaMatchesSource,
  formatSourceLine,
  buildMediaMatchText,
  buildFallbackText,
  buildContentMatchPrompt,
  parseContentMatchResponse,
};
