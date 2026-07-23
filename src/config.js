'use strict';

// 隅消息上稿系統 — 環境變數檢查
// 啟動時逐一檢查並印出狀態(絕不印出值本身)。

// 全部需要檢查的環境變數名稱(順序即輸出順序)。
const ENV_NAMES = [
  'PORT',
  'ADMIN_PASSWORD',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'PEXELS_API_KEY',
  'UNSPLASH_ACCESS_KEY',
  'WP_BASE_URL',
  'WP_USERNAME',
  'WP_APP_PASSWORD',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'DRIVE_ROOT_FOLDER_ID',
  'SHEET_ID',
];

// 缺少某變數時，用來提醒「哪些功能會受影響」的說明。
const IMPACT_HINTS = {
  ADMIN_PASSWORD: '無法登入系統(登入功能未設定)',
  ANTHROPIC_API_KEY: '無法自動抽取關鍵字(需手動指定關鍵字搜圖)',
  GEMINI_API_KEY: '無法從網頁觸發補搜候選題目',
  PEXELS_API_KEY: 'Pexels 搜尋會略過',
  UNSPLASH_ACCESS_KEY: 'Unsplash 搜尋會略過',
  WP_BASE_URL: '無法建立 WordPress 草稿',
  WP_USERNAME: '無法建立 WordPress 草稿',
  WP_APP_PASSWORD: '無法建立 WordPress 草稿',
  GOOGLE_SERVICE_ACCOUNT_JSON: '無法存檔到 Google Drive 或記錄到 Google Sheets',
  DRIVE_ROOT_FOLDER_ID: '無法存檔到 Google Drive',
  SHEET_ID: '無法記錄到 Google Sheets',
};

/**
 * 檢查某個環境變數是否已設定(存在且 trim 後非空字串)。
 * @param {string} name 環境變數名稱
 * @returns {boolean}
 */
function isSet(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 回傳 names 陣列中「未設定」的變數名稱。
 * @param {string[]} names
 * @returns {string[]}
 */
function missing(names) {
  return names.filter((name) => !isSet(name));
}

/**
 * 啟動時在 console 印出每個變數的設定狀態(繁體中文)。
 * 注意：只印變數名稱與狀態，絕不印出值本身。
 * PORT 為特例：缺少時視為「未設定(使用預設 3000)」且不算缺少。
 */
function checkEnvAtStartup() {
  console.log('===== 環境變數檢查 =====');

  const missingNames = [];

  for (const name of ENV_NAMES) {
    if (isSet(name)) {
      console.log(`  ✅ ${name}：已設定`);
      continue;
    }

    // PORT 特例：缺少不影響運作(fallback 預設 3000)。
    if (name === 'PORT') {
      console.log(`  ⚠️  ${name}：未設定(使用預設 3000)`);
      continue;
    }

    console.log(`  ❌ ${name}：缺少`);
    missingNames.push(name);
  }

  if (missingNames.length === 0) {
    console.log('全部環境變數皆已設定。');
  } else {
    console.log('----- 受影響的功能 -----');
    for (const name of missingNames) {
      const hint = IMPACT_HINTS[name] || '相關功能會受影響';
      console.log(`  缺少 ${name} → ${hint}`);
    }
    console.log(
      `提醒：目前缺少 ${missingNames.length} 個環境變數（${missingNames.join('、')}），上述功能將無法使用或會略過。`
    );
  }

  console.log('========================');

  return missingNames;
}

module.exports = {
  ENV_NAMES,
  isSet,
  missing,
  checkEnvAtStartup,
};
