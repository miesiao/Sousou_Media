'use strict';

// 一次性腳本：用你的個人 Google 帳號授權 Drive，取得 refresh token。
// 用法：node get_drive_token.js
// 執行前請確認 .env 已填入 GOOGLE_OAUTH_CLIENT_ID 和 GOOGLE_OAUTH_CLIENT_SECRET。

require('dotenv').config();

const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3001';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('錯誤：請先在 .env 填入 GOOGLE_OAUTH_CLIENT_ID 和 GOOGLE_OAUTH_CLIENT_SECRET');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n請在瀏覽器開啟以下網址，用你的個人 Google 帳號授權：\n');
  console.log(authUrl);
  console.log('\n授權完成後程式會自動繼續...\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.query.code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>授權成功！請回到終端機查看 refresh token。</h1>');
        server.close();
        resolve(parsed.query.code);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(3001, () => {});
    server.on('error', reject);
  });

  const { tokens } = await oauth2Client.getToken(code);

  console.log('\n===== 授權成功，請把下面這行加到 .env =====\n');
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\n==============================================\n');
}

main().catch((err) => {
  console.error('授權失敗：', err.message);
  process.exit(1);
});
