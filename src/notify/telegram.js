'use strict';

const https = require('node:https');
function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function defaultRequest(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { raw += chunk; }); res.on('end', () => {
        try { const parsed = JSON.parse(raw); if (res.statusCode < 200 || res.statusCode >= 300 || !parsed.ok) reject(new Error(parsed.description || `Telegram HTTP ${res.statusCode}`)); else resolve(parsed); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(data);
  });
}
async function sendTelegram({ token, chatId, text }, { request = defaultRequest } = {}) {
  if (!token || !chatId) throw new Error('Telegram 봇 토큰과 채팅 ID를 설정해 주세요.');
  const chunks = []; let rest = String(text || '');
  while (rest.length > 3900) { let cut = rest.lastIndexOf('<br>', 3900); if (cut < 1800) cut = 3900; chunks.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^<br>/, ''); }
  if (rest || !chunks.length) chunks.push(rest);
  const results = [];
  for (const chunk of chunks) results.push(await request(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true }));
  return { ok: true, sent: results.length };
}
async function findChatId(token, { request = defaultRequest } = {}) {
  if (!token) throw new Error('Telegram 봇 토큰을 입력해 주세요.');
  const result = await request(`https://api.telegram.org/bot${token}/getUpdates`, {});
  const updates = result.result || []; const message = [...updates].reverse().map((update) => update.message || update.channel_post || update.edited_message).find(Boolean);
  if (!message || !message.chat || message.chat.id == null) throw new Error('봇에 메시지를 먼저 보낸 뒤 다시 찾아 주세요.');
  const chat = message.chat;
  return { chatId: String(chat.id), name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '' };
}
module.exports = { sendTelegram, findChatId, escapeHtml, defaultRequest };
