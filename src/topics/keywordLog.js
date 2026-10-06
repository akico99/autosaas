'use strict';

const fsDefault = require('node:fs');
const pathDefault = require('node:path');

function normalizeKeyword(keyword) {
  return String(keyword || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim();
}

function findKeywordConflict(records, { topicId, blogKey, keyword, now = Date.now() } = {}) {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) return null;
  const at = typeof now === 'number' ? now : Date.parse(now);
  let differentBlog = null;
  let sameBlog = null;
  for (const record of Array.isArray(records) ? records : []) {
    if (record.topicId !== topicId || normalizeKeyword(record.keyword) !== normalized) continue;
    const recordedAt = Date.parse(record.at);
    if (!Number.isFinite(recordedAt)) continue;
    const ageDays = (at - recordedAt) / 86400000;
    if (ageDays < 0) continue;
    if (record.blogKey === blogKey && ageDays <= 14 && (!sameBlog || recordedAt > Date.parse(sameBlog.at))) sameBlog = record;
    if (record.blogKey !== blogKey && ageDays <= 30 && (!differentBlog || recordedAt > Date.parse(differentBlog.at))) differentBlog = record;
  }
  if (differentBlog) return { kind: 'different-blog', record: differentBlog };
  if (sameBlog) return { kind: 'same-blog', record: sameBlog };
  return null;
}

function appendKeywordLog(file, record, { fs = fsDefault, path = pathDefault } = {}) {
  let records = [];
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); records = Array.isArray(data) ? data : []; } catch (_) {}
  records.push({ ...record, keyword: normalizeKeyword(record.keyword), at: record.at || new Date().toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records, null, 2), 'utf8');
  fs.renameSync(temp, file);
  return records;
}

module.exports = { normalizeKeyword, findKeywordConflict, appendKeywordLog };
