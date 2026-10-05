'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const CACHE_TTL_MS = 30 * 60 * 1000;
const BLOCK_TTL_MS = 30 * 60 * 1000;
const REPEAT_BLOCK_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_REQUEST_GAP_MS = 1500;
const MAX_CACHE_ENTRIES = 24;
const MAX_PERSISTED_ENTRIES = 8;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_STORED_ENTRY_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 900 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const STATE_FILE = 'search-state.json';
const BLOCK_MESSAGE = '네이버 검색이 일시적으로 제한되어 자료 수집을 멈췄습니다. 잠시 후 다시 시도해 주세요.';

function defaultStorageDirectory() {
  if (process.env.NAVER_AUTO_CACHE_DIR) return process.env.NAVER_AUTO_CACHE_DIR;
  const appData = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(appData, 'blog-auto');
}

class NaverSearchBlockedError extends Error {
  constructor({ status = 403, kind = 'blocked', code } = {}) {
    super(BLOCK_MESSAGE);
    this.name = 'NaverSearchBlockedError';
    this.status = status;
    this.kind = kind;
    this.code = code || (status === 429 ? 'NAVER_SEARCH_RATE_LIMITED' : 'NAVER_SEARCH_BLOCKED');
  }
}

class SearchCollectionError extends Error {
  constructor(message, { kind = 'network_error', status, code = 'SEARCH_COLLECTION_FAILED' } = {}) {
    super(message || '검색 자료를 가져오지 못했습니다.');
    this.name = 'SearchCollectionError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

let now = () => Date.now();
let transport = defaultTransport;
let storageDir = defaultStorageDirectory();
let testMode = false;
let cache = new Map();
let blockedUntil = 0;
let lastBlockAt = 0;
let lastBlockStatus = 0;
let lastRequestAt = 0;
let queue = Promise.resolve();

function defaultTransport(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          tooLarge = true;
          const error = new SearchCollectionError('검색 응답 크기가 제한을 넘었습니다.', { kind: 'response_too_large', code: 'SEARCH_RESPONSE_TOO_LARGE' });
          res.destroy(error);
          reject(error);
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on('end', () => {
        if (!tooLarge) resolve({ status: Number(res.statusCode) || 0, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', (error) => reject(classifyTransportError(error)));
    req.setTimeout(12000, () => req.destroy(Object.assign(new Error('요청 시간초과'), { code: 'ETIMEDOUT' })));
  });
}

function classifyTransportError(error) {
  const timeout = error && (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') || /시간초과|timed? ?out/i.test(String(error && error.message || ''));
  return new SearchCollectionError(error && error.message, {
    kind: timeout ? 'timeout' : 'network_error',
    code: timeout ? 'SEARCH_TIMEOUT' : 'SEARCH_NETWORK_ERROR',
  });
}

function normalizeResponse(value) {
  const response = value && typeof value === 'object' && ('status' in value || 'body' in value)
    ? value
    : { status: 200, body: value };
  return {
    status: Number(response.status) || 0,
    body: Buffer.isBuffer(response.body) ? Buffer.from(response.body) : Buffer.from(String(response.body == null ? '' : response.body)),
    collectedAt: typeof response.collectedAt === 'string' ? response.collectedAt : null,
  };
}

function bodyText(body) { return Buffer.isBuffer(body) ? body.toString('utf8') : String(body || ''); }

function isBlockPage(status, body) {
  return Number(status) === 403 || Number(status) === 429 || /검색 서비스 이용이 제한|서비스 이용이 제한|비정상적인 접근/.test(bodyText(body));
}

function statePath() { return path.join(storageDir, STATE_FILE); }

function safeStateWrite() {
  if (testMode || !storageDir) return;
  try {
    const timestamp = now();
    const entries = [];
    for (const [key, item] of cache) {
      if (item.expiresAt <= timestamp || !isPersistableKey(key) || item.response.body.length > MAX_ENTRY_BYTES) continue;
      const packed = zlib.gzipSync(item.response.body, { level: 6 });
      if (packed.length > MAX_STORED_ENTRY_BYTES) continue;
      entries.push({ key, expiresAt: item.expiresAt, status: item.response.status, collectedAt: item.response.collectedAt, encoding: 'gzip-base64', body: packed.toString('base64') });
    }
    const saved = {
      version: 1,
      blockedUntil: blockedUntil > timestamp ? blockedUntil : 0,
      lastBlockAt: lastBlockAt && timestamp - lastBlockAt <= REPEAT_BLOCK_TTL_MS ? lastBlockAt : 0,
      lastBlockStatus: lastBlockAt && timestamp - lastBlockAt <= REPEAT_BLOCK_TTL_MS ? lastBlockStatus : 0,
      entries: entries.slice(-MAX_PERSISTED_ENTRIES),
    };
    let serialized = JSON.stringify(saved);
    while (Buffer.byteLength(serialized) > MAX_STATE_BYTES && saved.entries.length) {
      saved.entries.shift();
      serialized = JSON.stringify(saved);
    }
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) return;
    fs.mkdirSync(storageDir, { recursive: true });
    const file = statePath();
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (_) { /* persistence must never interrupt collection */ }
}

function isPersistableKey(key) {
  if (key.startsWith('http:')) {
    try { return new URL(key.slice(5)).hostname === 'search.naver.com'; } catch (_) { return false; }
  }
  if (!key.startsWith('rendered:')) return false;
  try { return new URL(key.slice('rendered:'.length)).hostname === 'search.naver.com'; } catch (_) { return false; }
}

function loadState() {
  if (testMode || !storageDir) return;
  try {
    const file = statePath();
    const stat = fs.statSync(file);
    if (stat.size > MAX_STATE_BYTES) return;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved || saved.version !== 1 || !Array.isArray(saved.entries)) return;
    const timestamp = now();
    if (Number.isFinite(saved.blockedUntil) && saved.blockedUntil > timestamp) blockedUntil = saved.blockedUntil;
    if (Number.isFinite(saved.lastBlockAt) && saved.lastBlockAt > 0 && timestamp - saved.lastBlockAt <= REPEAT_BLOCK_TTL_MS) {
      lastBlockAt = saved.lastBlockAt;
      lastBlockStatus = Number(saved.lastBlockStatus) || 403;
    }
    const nextCache = new Map();
    for (const entry of saved.entries.slice(-MAX_PERSISTED_ENTRIES)) {
      try {
        if (!entry || typeof entry.key !== 'string' || !isPersistableKey(entry.key)) continue;
        if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= timestamp || !Number.isInteger(entry.status) || entry.status < 200 || entry.status >= 300) continue;
        if (typeof entry.body !== 'string' || entry.body.length > Math.ceil(MAX_STORED_ENTRY_BYTES * 4 / 3) || entry.encoding !== 'gzip-base64') continue;
        const packed = Buffer.from(entry.body, 'base64');
        if (packed.length > MAX_STORED_ENTRY_BYTES) continue;
        const body = zlib.gunzipSync(packed, { maxOutputLength: MAX_ENTRY_BYTES });
        if (body.length > MAX_ENTRY_BYTES) continue;
        const collectedAt = typeof entry.collectedAt === 'string' && Number.isFinite(Date.parse(entry.collectedAt))
          ? new Date(entry.collectedAt).toISOString() : null;
        if (!collectedAt) continue;
        nextCache.set(entry.key, { expiresAt: entry.expiresAt, response: { status: entry.status, body, collectedAt } });
      } catch (_) { /* ignore a damaged entry without losing cooldown state */ }
    }
    cache = nextCache;
  } catch (_) { /* absent or corrupt state starts fresh */ }
}

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (item.expiresAt <= now()) { cache.delete(key); return null; }
  return { status: item.response.status, body: Buffer.from(item.response.body), collectedAt: item.response.collectedAt };
}

function setCached(key, response) {
  if (response.status < 200 || response.status >= 300) return;
  const body = Buffer.from(response.body);
  const collectedAt = response.collectedAt || new Date(now()).toISOString();
  cache.set(key, { expiresAt: now() + CACHE_TTL_MS, response: { status: response.status, body, collectedAt } });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  safeStateWrite();
}

function isSearchBlocked() { return blockedUntil > now(); }

function getBlockState() {
  const active = isSearchBlocked();
  const status = active ? lastBlockStatus || 403 : null;
  return {
    blocked: active,
    blockedUntil: active ? new Date(blockedUntil).toISOString() : null,
    remainingMs: active ? Math.max(0, blockedUntil - now()) : 0,
    status,
    kind: active ? (status === 429 ? 'rate_limited' : 'blocked') : '',
    code: active ? (status === 429 ? 'NAVER_SEARCH_RATE_LIMITED' : 'NAVER_SEARCH_BLOCKED') : '',
    message: active ? BLOCK_MESSAGE : '',
  };
}

function recordBlock(status) {
  const timestamp = now();
  const repeated = lastBlockAt > 0 && timestamp - lastBlockAt <= REPEAT_BLOCK_TTL_MS;
  lastBlockAt = timestamp;
  lastBlockStatus = status;
  blockedUntil = timestamp + (repeated ? REPEAT_BLOCK_TTL_MS : BLOCK_TTL_MS);
  safeStateWrite();
  return new NaverSearchBlockedError({
    status,
    kind: status === 429 ? 'rate_limited' : 'blocked',
  });
}

function errorPayload(response) {
  const text = bodyText(response.body);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && parsed.error ? String(parsed.error) : '';
  } catch (_) { return ''; }
}

async function waitForRequestGap() {
  const remaining = MIN_REQUEST_GAP_MS - (now() - lastRequestAt);
  if (lastRequestAt && remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  lastRequestAt = now();
}

function enqueue(fn) {
  const operation = queue.then(fn, fn);
  queue = operation.catch(() => {});
  return operation;
}

async function request(key, fetcher, { persist = true } = {}) {
  const hit = getCached(key);
  if (hit) return hit;
  if (isSearchBlocked()) throw new NaverSearchBlockedError({ status: lastBlockStatus || 403, kind: lastBlockStatus === 429 ? 'rate_limited' : 'blocked' });
  await waitForRequestGap();
  let response;
  try { response = normalizeResponse(await fetcher()); }
  catch (error) {
    if (error instanceof NaverSearchBlockedError) {
      if (!isSearchBlocked()) throw recordBlock(error.status === 429 ? 429 : 403);
      throw error;
    }
    if (error instanceof SearchCollectionError) throw error;
    if (error && (error.kind === 'blocked' || error.kind === 'rate_limited') && (Number(error.status) === 403 || Number(error.status) === 429)) {
      throw recordBlock(Number(error.status));
    }
    if (error && error.kind && ['load_error', 'render_error', 'parse_error', 'parser_mismatch', 'timeout', 'network_error'].includes(error.kind)) {
      throw new SearchCollectionError(error.message, {
        kind: error.kind,
        status: Number.isFinite(Number(error.status)) ? Number(error.status) : undefined,
        code: error.code || 'SEARCH_COLLECTION_FAILED',
      });
    }
    throw classifyTransportError(error);
  }
  if (isBlockPage(response.status, response.body)) throw recordBlock(response.status === 429 ? 429 : 403);
  if (response.status < 200 || response.status >= 300) {
    throw new SearchCollectionError(`검색 요청이 HTTP ${response.status}로 실패했습니다.`, {
      kind: 'http_error', status: response.status, code: 'SEARCH_HTTP_ERROR',
    });
  }
  const payloadError = errorPayload(response);
  if (payloadError) throw new SearchCollectionError(payloadError, { kind: 'render_error', code: 'SEARCH_RENDER_ERROR' });
  response.collectedAt = response.collectedAt || new Date(now()).toISOString();
  blockedUntil = 0;
  lastBlockAt = 0;
  lastBlockStatus = 0;
  if (persist) setCached(key, response);
  return response;
}

function guardedSearchFetch(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return Promise.reject(new SearchCollectionError('검색 주소가 올바르지 않습니다.', { kind: 'invalid_url', code: 'SEARCH_INVALID_URL' })); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'search.naver.com') {
    return Promise.reject(new SearchCollectionError('검색 수집은 search.naver.com HTTPS 주소만 허용합니다.', { kind: 'invalid_url', code: 'SEARCH_HOST_NOT_ALLOWED' }));
  }
  const key = 'http:' + parsed.toString();
  return enqueue(() => request(key, () => transport(parsed.toString())));
}

function runGuardedSearch(key, fetcher) {
  return enqueue(() => request('rendered:' + String(key).replace(/^rendered:/, ''), fetcher));
}

function setStorageDir(dir) {
  storageDir = path.resolve(String(dir));
  testMode = false;
  cache = new Map(); blockedUntil = 0; lastBlockAt = 0; lastBlockStatus = 0;
  loadState();
}

function _setTransportForTest(fn) { transport = fn || defaultTransport; }
function _setClockForTest(fn) {
  now = fn || (() => Date.now());
  if (!testMode && storageDir) {
    cache = new Map(); blockedUntil = 0; lastBlockAt = 0; lastBlockStatus = 0;
    loadState();
  }
}
function _resetForTest() {
  testMode = true; cache.clear(); blockedUntil = 0; lastBlockAt = 0; lastBlockStatus = 0; lastRequestAt = 0; queue = Promise.resolve();
  transport = defaultTransport; now = () => Date.now(); storageDir = null;
}

loadState();

module.exports = {
  guardedSearchFetch,
  runGuardedSearch,
  isSearchBlocked,
  getBlockState,
  NaverSearchBlockedError,
  SearchCollectionError,
  isBlockPage,
  setStorageDir,
  _setTransportForTest,
  _setClockForTest,
  _resetForTest,
};
