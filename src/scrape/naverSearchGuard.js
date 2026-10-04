const https = require('https');

const CACHE_TTL_MS = 30 * 60 * 1000;
const BLOCK_TTL_MS = 30 * 60 * 1000;
const REPEAT_BLOCK_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_GAP_MS = 1500;
const MAX_JITTER_MS = 1000;
const BLOCK_MESSAGE = '네이버 검색이 이 네트워크에서 일시 제한됐어요. 브라우저로 네이버 검색에 접속해 [제한 해제] 보안 절차를 직접 진행한 뒤 다시 시도하세요.';

const cache = new Map();
const renderedCache = new Map();
let queue = Promise.resolve();
let blockedAtMs = null;
let blockedUntilMs = null;
let consecutiveBlocks = 0;
let lastCompletedAt = null;
let transport = defaultTransport;
let clock = () => Date.now();

class NaverSearchBlockedError extends Error {
  constructor(message = BLOCK_MESSAGE) {
    super(message);
    this.name = 'NaverSearchBlockedError';
    this.code = 'NAVER_SEARCH_BLOCKED';
  }
}

function nowMs() {
  const value = clock();
  if (value instanceof Date) return value.getTime();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function bodyText(body) {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body == null) return '';
  return String(body);
}

function isBlockPage(status, body) {
  return Number(status) === 403 || bodyText(body).includes('검색 서비스 이용이 제한되었습니다');
}

function isSearchBlocked() {
  return blockedUntilMs != null && nowMs() < blockedUntilMs;
}

function getBlockState() {
  return {
    blocked: isSearchBlocked(),
    blockedAt: blockedAtMs == null ? null : new Date(blockedAtMs).toISOString(),
    blockedUntil: blockedUntilMs == null ? null : new Date(blockedUntilMs).toISOString(),
    message: BLOCK_MESSAGE,
  };
}

function defaultTransport(url, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          Accept: '*/*',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('요청 시간초과')));
    } catch (error) { reject(error); }
  });
}

function normalizeResponse(response) {
  const raw = response && typeof response === 'object' && ('body' in response || 'status' in response)
    ? response
    : { status: 200, body: response };
  const body = Buffer.isBuffer(raw.body) ? raw.body : Buffer.from(bodyText(raw.body), 'utf8');
  return { status: Number(raw.status) || 0, body };
}

function validCached(source, key, now) {
  const item = source.get(key);
  if (!item) return null;
  if (item.expiresAt <= now) { source.delete(key); return null; }
  return item.value;
}

async function waitForGap() {
  if (lastCompletedAt == null) return;
  const delay = MIN_GAP_MS + Math.floor(Math.random() * (MAX_JITTER_MS + 1));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function recordBlockedSearch() {
  consecutiveBlocks += 1;
  blockedAtMs = nowMs();
  blockedUntilMs = blockedAtMs + (consecutiveBlocks >= 2 ? REPEAT_BLOCK_TTL_MS : BLOCK_TTL_MS);
}

function normalizeTextResponse(response) {
  const raw = response && typeof response === 'object' ? response : {};
  return { status: Number(raw.status) || 0, body: bodyText(raw.body) };
}

async function perform(url, opts) {
  const now = nowMs();
  const cached = validCached(cache, url, now);
  if (cached) return cached;
  if (isSearchBlocked()) throw new NaverSearchBlockedError();

  await waitForGap();
  let raw;
  try {
    raw = await transport(url, { timeoutMs: 12000, ...(opts || {}) });
  } catch (error) {
    consecutiveBlocks = 0;
    throw error;
  } finally {
    lastCompletedAt = nowMs();
  }
  const result = normalizeResponse(raw);
  if (isBlockPage(result.status, result.body)) {
    recordBlockedSearch();
    throw new NaverSearchBlockedError();
  }
  consecutiveBlocks = 0;
  if (result.status === 200) {
    cache.set(url, { value: result, expiresAt: nowMs() + CACHE_TTL_MS });
  }
  return result;
}

async function performGuardedSearch(key, fn) {
  const cached = validCached(renderedCache, key, nowMs());
  if (cached) return cached;
  if (isSearchBlocked()) throw new NaverSearchBlockedError();

  await waitForGap();
  let raw;
  try {
    raw = await fn();
  } catch (error) {
    consecutiveBlocks = 0;
    throw error;
  } finally {
    lastCompletedAt = nowMs();
  }
  const result = normalizeTextResponse(raw);
  if (isBlockPage(result.status, result.body)) {
    recordBlockedSearch();
    throw new NaverSearchBlockedError();
  }
  consecutiveBlocks = 0;
  renderedCache.set(key, { value: result, expiresAt: nowMs() + CACHE_TTL_MS });
  return result;
}

function guardedSearchFetch(url, opts) {
  let parsed;
  try { parsed = new URL(String(url)); } catch (error) { return Promise.reject(new TypeError('검색 URL이 올바르지 않습니다.')); }
  if (parsed.hostname.toLowerCase() !== 'search.naver.com') {
    return Promise.reject(new TypeError('guardedSearchFetch는 search.naver.com 요청만 처리합니다.'));
  }
  const task = queue.then(() => perform(parsed.toString(), opts));
  queue = task.then(() => undefined, () => undefined);
  return task;
}

function runGuardedSearch(key, fn) {
  if (typeof fn !== 'function') return Promise.reject(new TypeError('runGuardedSearch에는 함수가 필요합니다.'));
  const cacheKey = String(key);
  const task = queue.then(() => performGuardedSearch(cacheKey, fn));
  queue = task.then(() => undefined, () => undefined);
  return task;
}

function _setTransportForTest(fn) { transport = typeof fn === 'function' ? fn : defaultTransport; }
function _setClockForTest(fn) { clock = typeof fn === 'function' ? fn : (() => Date.now()); }
function _resetForTest() {
  cache.clear();
  renderedCache.clear();
  queue = Promise.resolve();
  blockedAtMs = null;
  blockedUntilMs = null;
  consecutiveBlocks = 0;
  lastCompletedAt = null;
  transport = defaultTransport;
  clock = () => Date.now();
}

module.exports = {
  guardedSearchFetch, runGuardedSearch, isSearchBlocked, getBlockState, NaverSearchBlockedError, isBlockPage,
  _setTransportForTest, _setClockForTest, _resetForTest,
};
