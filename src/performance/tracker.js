const crypto = require('crypto');

const DUE_DAYS = Object.freeze([1, 3, 7, 14, 28]);
const DAY_MS = 24 * 60 * 60 * 1000;

function toTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  if (!text) return NaN;
  if (/^\d{8}$/.test(text)) {
    return Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
  }
  if (/^\d{14}$/.test(text)) {
    return Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)), Number(text.slice(8, 10)), Number(text.slice(10, 12)), Number(text.slice(12, 14)));
  }
  if (/^\d{13}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeTitle(title) {
  return String(title || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[\s\p{P}\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D]/gu, '');
}

function createEntry({ keyword, topic, intent, status, title, generatedAt, version } = {}) {
  const at = generatedAt || new Date().toISOString();
  const timestamp = toTime(at);
  const ms = Number.isFinite(timestamp) ? timestamp : Date.now();
  const hash = crypto.createHash('sha256').update(String(keyword || ''), 'utf8').digest('hex').slice(0, 8);
  return {
    id: String(ms) + '-' + hash,
    keyword: String(keyword || ''),
    topic: String(topic || ''),
    intent: String(intent || 'general'),
    statusAtGen: String(status || 'review'),
    titleAtGen: String(title || ''),
    generatedAt: at,
    version: String(version || ''),
    url: null,
    blogId: null,
    logNo: null,
    publishedAt: null,
    linkedBy: null,
    checks: [],
  };
}

function parseBlogUrl(value) {
  const text = String(value || '').trim();
  const match = text.match(/^https?:\/\/(?:m\.)?blog\.naver\.com\/([A-Za-z0-9_-]+)\/(\d+)(?:[/?#].*)?$/i);
  return match ? { blogId: match[1], logNo: match[2] } : null;
}

function titleMatchScore(entryTitle, postTitle) {
  const a = normalizeTitle(entryTitle);
  const b = normalizeTitle(postTitle);
  if (!a || !b) return 0;
  if (a === b) return 2;
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return ratio >= 0.85 && (a.includes(b) || b.includes(a)) ? 1 : 0;
}

function matchPublished(entries, posts) {
  const output = (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    checks: Array.isArray(entry.checks) ? entry.checks.map((check) => ({ ...check })) : [],
  }));
  const available = new Set(output.map((_, index) => index).filter((index) => !output[index].url));
  for (const post of Array.isArray(posts) ? posts : []) {
    const postTitle = String(post && post.title || '');
    let bestIndex = -1;
    let bestScore = 0;
    const publishedMs = post && post.addDate != null ? toTime(post.addDate) : NaN;
    for (const index of available) {
      const entry = output[index];
      const generatedMs = toTime(entry.generatedAt);
      if (Number.isFinite(publishedMs) && Number.isFinite(generatedMs) && publishedMs < generatedMs) continue;
      const score = titleMatchScore(entry.titleAtGen, postTitle);
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    if (bestIndex < 0) continue;
    const entry = output[bestIndex];
    const url = String(post.url || '');
    const parsed = parseBlogUrl(url);
    entry.url = url || null;
    entry.blogId = parsed ? parsed.blogId : null;
    entry.logNo = parsed ? parsed.logNo : null;
    entry.publishedAt = post.addDate != null ? post.addDate : new Date().toISOString();
    entry.linkedBy = 'auto';
    available.delete(bestIndex);
  }
  return output;
}

function linkManually(entry, url) {
  const parsed = parseBlogUrl(url);
  if (!parsed) throw new Error('네이버 블로그 글 주소 형식이 올바르지 않습니다.');
  return {
    ...entry,
    url: String(url).trim(),
    blogId: parsed.blogId,
    logNo: parsed.logNo,
    publishedAt: entry && entry.publishedAt != null ? entry.publishedAt : new Date().toISOString(),
    linkedBy: 'manual',
    checks: Array.isArray(entry && entry.checks) ? entry.checks.map((check) => ({ ...check })) : [],
  };
}

function dueChecks(entries, now = Date.now()) {
  const nowMs = toTime(now);
  const due = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const publishedMs = toTime(entry && entry.publishedAt);
    if (!Number.isFinite(publishedMs)) continue;
    const recorded = new Set((Array.isArray(entry.checks) ? entry.checks : []).map((check) => Number(check && check.dueDay)));
    const eligible = DUE_DAYS.filter((day) => !recorded.has(day) && nowMs >= publishedMs + day * DAY_MS);
    if (eligible.length) due.push({ id: entry.id, dueDay: Math.max(...eligible), publishedMs });
  }
  return due.sort((a, b) => a.publishedMs - b.publishedMs).map(({ id, dueDay }) => ({ id, dueDay }));
}

function findRank(blogRefs, blogId, logNo) {
  const index = (Array.isArray(blogRefs) ? blogRefs : []).findIndex((ref) =>
    String(ref && ref.blogId || '') === String(blogId || '') && String(ref && ref.logNo || '') === String(logNo || ''));
  return index >= 0 ? index + 1 : null;
}

function addCheck(entry, check = {}) {
  const checks = Array.isArray(entry && entry.checks) ? entry.checks.map((item) => ({ ...item })) : [];
  const next = {
    at: check.at || new Date().toISOString(),
    dueDay: Number(check.dueDay),
    blogTabRank: check.blogTabRank == null ? null : Number(check.blogTabRank),
    blogTabObserved: !!check.blogTabObserved,
    inIntegrated: !!check.inIntegrated,
    measured: !!check.measured,
    reason: check.reason ? String(check.reason) : '',
  };
  const index = checks.findIndex((item) => Number(item.dueDay) === next.dueDay);
  if (index >= 0) checks[index] = next;
  else checks.push(next);
  return { ...entry, checks };
}

function emptySummary() {
  return { tracked: 0, linked: 0, checked: 0, found: 0, top10: 0, medianBestRank: null };
}

function summarizeGroup(entries) {
  const ranks = [];
  let linked = 0;
  let checked = 0;
  for (const entry of entries) {
    if (entry.url) linked++;
    const checks = Array.isArray(entry.checks) ? entry.checks : [];
    if (checks.length) checked++;
    const measuredRanks = checks
      .filter((check) => check && check.measured && check.blogTabRank != null && Number.isFinite(Number(check.blogTabRank)))
      .map((check) => Number(check.blogTabRank));
    if (measuredRanks.length) ranks.push(Math.min(...measuredRanks));
  }
  ranks.sort((a, b) => a - b);
  const middle = Math.floor(ranks.length / 2);
  const medianBestRank = !ranks.length ? null : ranks.length % 2
    ? ranks[middle]
    : (ranks[middle - 1] + ranks[middle]) / 2;
  return {
    tracked: entries.length,
    linked,
    checked,
    found: ranks.length,
    top10: ranks.filter((rank) => rank <= 10).length,
    medianBestRank,
  };
}

function summarize(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byIntent = {};
  for (const entry of list) {
    const intent = String(entry.intent || 'general');
    if (!byIntent[intent]) byIntent[intent] = [];
    byIntent[intent].push(entry);
  }
  const byStatus = { ready: [], review: [], hold: [] };
  for (const entry of list) {
    const status = String(entry.statusAtGen || 'review');
    if (!byStatus[status]) byStatus[status] = [];
    byStatus[status].push(entry);
  }
  return {
    byIntent: Object.fromEntries(Object.entries(byIntent).map(([key, group]) => [key, summarizeGroup(group)])),
    byStatus: Object.fromEntries(Object.entries(byStatus).map(([key, group]) => [key, summarizeGroup(group)])),
  };
}

module.exports = { DUE_DAYS, createEntry, normalizeTitle, matchPublished, linkManually, dueChecks, findRank, addCheck, summarize };
