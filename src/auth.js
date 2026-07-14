'use strict';

// 隅消息上稿系統 — 簡易密碼保護
// 規格：進入頁面先輸入密碼(比對 ADMIN_PASSWORD)，通過後發一個 session cookie。
// 這不是完整會員系統，只是一層簡易保護。

const crypto = require('crypto');

// session token 有效期：24 小時(毫秒)。
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// in-memory 儲存有效 session：token → 建立時間戳(毫秒)。
// 服務重啟即全部失效，符合規格可接受。
const sessions = new Map();

/**
 * 從 Cookie header 字串手動 parse 出指定名稱的 cookie 值。
 * (規格要求不使用 cookie-parser。)
 * @param {string|undefined} cookieHeader req.headers.cookie
 * @param {string} name cookie 名稱
 * @returns {string|null}
 */
function parseCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

/**
 * 判斷 token 是否有效(存在且未過期)。過期時順手清除。
 * @param {string|null} token
 * @returns {boolean}
 */
function isValidToken(token) {
  if (!token) return false;
  const createdAt = sessions.get(token);
  if (createdAt === undefined) return false;

  if (Date.now() - createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/**
 * 登入：比對密碼並發放新 token。
 * - ADMIN_PASSWORD 未設定 → throw Error(功能未設定)。
 * - 密碼錯誤 → 回傳 null。
 * - 密碼正確 → 產生並回傳新 token。
 * @param {string} password
 * @returns {string|null} 新的 session token
 */
function login(password) {
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (typeof adminPassword !== 'string' || adminPassword.trim() === '') {
    throw new Error(
      '登入功能未設定(缺少 ADMIN_PASSWORD)，請先在環境變數設定管理密碼'
    );
  }

  if (password !== adminPassword) {
    return null;
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  return token;
}

/**
 * 從 request 讀出 session cookie 並判斷是否已登入。
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function isAuthenticated(req) {
  const token = parseCookie(req.headers && req.headers.cookie, 'session');
  return isValidToken(token);
}

/**
 * Express middleware：驗證 session cookie，無效回 401 JSON。
 */
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }
  return res.status(401).json({ error: '未登入或登入已過期' });
}

module.exports = {
  login,
  requireAuth,
  isAuthenticated,
  parseCookie,
  SESSION_TTL_MS,
};
