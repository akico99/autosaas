const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const guard = require('../../src/scrape/naverSearchGuard');
const health = require('../../src/scrape/health');
const doctorChecks = require('../doctorChecks');
const TEST_NOW = Date.now() + 24 * 60 * 60 * 1000;

function createDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autosaas-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runNode(dir, script) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    env: { ...process.env, NAVER_AUTO_CACHE_DIR: dir },
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('429 is classified and its cooldown prevents a request after a process restart', (t) => {
  const dir = createDirectory(t);
  const url = 'https://search.naver.com/search.naver?query=429-fixture';
  const first = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    guard._setClockForTest(() => ${TEST_NOW});
    guard._setTransportForTest(async () => ({ status: 429, body: 'too many requests' }));
    guard.guardedSearchFetch(${JSON.stringify(url)}).then(
      (response) => console.log(JSON.stringify({ kind: 'resolved', status: response.status })),
      (error) => console.log(JSON.stringify({ kind: error.kind, code: error.code, blocked: guard.getBlockState().blocked }))
    );
  `);
  assert.deepEqual(first, { kind: 'rate_limited', code: 'NAVER_SEARCH_RATE_LIMITED', blocked: true });

  const restarted = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    guard._setClockForTest(() => ${TEST_NOW});
    let calls = 0;
    guard._setTransportForTest(async () => { calls++; return { status: 200, body: 'fresh' }; });
    guard.guardedSearchFetch(${JSON.stringify(url)}).then(
      (response) => console.log(JSON.stringify({ kind: 'resolved', calls, status: response.status })),
      (error) => console.log(JSON.stringify({ kind: error.kind, calls, blocked: guard.getBlockState().blocked }))
    );
  `);
  assert.deepEqual(restarted, { kind: 'rate_limited', calls: 0, blocked: true });
});

test('a first block expires after its TTL but its short repeat history escalates a later block', (t) => {
  const dir = createDirectory(t);
  const url = 'https://search.naver.com/search.naver?query=repeat-fixture';
  const first = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    guard._setClockForTest(() => ${TEST_NOW});
    guard._setTransportForTest(async () => ({ status: 403, body: 'restricted' }));
    guard.guardedSearchFetch(${JSON.stringify(url)}).catch(() => console.log(JSON.stringify(guard.getBlockState())));
  `);
  assert.equal(first.blocked, true);

  const second = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    const now = ${TEST_NOW} + 31 * 60 * 1000;
    guard._setClockForTest(() => now);
    guard._setTransportForTest(async () => ({ status: 429, body: 'limited' }));
    guard.guardedSearchFetch(${JSON.stringify(url)}).then(
      (response) => console.log(JSON.stringify({ kind: 'resolved', status: response.status })),
      (error) => console.log(JSON.stringify({ kind: error.kind, remainingMs: new Date(guard.getBlockState().blockedUntil).getTime() - now }))
    );
  `);
  assert.deepEqual(second, { kind: 'rate_limited', remainingMs: 2 * 60 * 60 * 1000 });
});

test('successful responses survive restart only until their cache TTL', (t) => {
  const dir = createDirectory(t);
  const url = 'https://search.naver.com/search.naver?query=cache-ttl-fixture';
  const first = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    guard._setClockForTest(() => ${TEST_NOW});
    guard._setTransportForTest(async () => ({ status: 200, body: 'public fixture' }));
    guard.guardedSearchFetch(${JSON.stringify(url)}).then((response) => console.log(JSON.stringify({ body: response.body.toString(), collectedAt: response.collectedAt })));
  `);
  assert.deepEqual(first, { body: 'public fixture', collectedAt: new Date(TEST_NOW).toISOString() });
  const restarted = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    guard._setClockForTest(() => ${TEST_NOW});
    let calls = 0;
    guard._setTransportForTest(async () => { calls++; return { status: 200, body: 'new content' }; });
    guard.guardedSearchFetch(${JSON.stringify(url)}).then((response) => console.log(JSON.stringify({ body: response.body.toString(), collectedAt: response.collectedAt, calls })));
  `);
  assert.deepEqual(restarted, { body: 'public fixture', collectedAt: new Date(TEST_NOW).toISOString(), calls: 0 });
  const expired = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    guard._setClockForTest(() => ${TEST_NOW} + 31 * 60 * 1000);
    let calls = 0;
    guard._setTransportForTest(async () => { calls++; return { status: 200, body: 'fresh content' }; });
    guard.guardedSearchFetch(${JSON.stringify(url)}).then((response) => console.log(JSON.stringify({ body: response.body.toString(), calls })));
  `);
  assert.deepEqual(expired, { body: 'fresh content', calls: 1 });
});

test('guard ignores corrupt disk state and does not cache HTTP failures as successful content', async (t) => {
  const dir = createDirectory(t);
  fs.writeFileSync(path.join(dir, 'search-state.json'), '{broken', 'utf8');
  const url = 'https://search.naver.com/search.naver?query=transient-fixture';
  const failed = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    guard._setClockForTest(() => ${TEST_NOW});
    guard._setTransportForTest(async () => ({ status: 503, body: 'unavailable' }));
    guard.guardedSearchFetch(${JSON.stringify(url)}).then(
      (response) => console.log(JSON.stringify({ kind: 'resolved', status: response.status })),
      (error) => console.log(JSON.stringify({ kind: error.kind, status: error.status }))
    );
  `);
  assert.deepEqual(failed, { kind: 'http_error', status: 503 });
  const recovered = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    guard._setClockForTest(() => ${TEST_NOW});
    let calls = 0;
    guard._setTransportForTest(async () => { calls++; return { status: 200, body: 'recovered' }; });
    guard.guardedSearchFetch(${JSON.stringify(url)}).then((response) => console.log(JSON.stringify({ body: response.body.toString(), calls })));
  `);
  assert.deepEqual(recovered, { body: 'recovered', calls: 1 });
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'search-state.json'), 'utf8'));
  assert.equal(state.version, 1);
  assert.ok(fs.statSync(path.join(dir, 'search-state.json')).size < 1024 * 1024);
});

test('a corrupt cache entry does not erase a valid persisted rate limit', (t) => {
  const dir = createDirectory(t);
  fs.writeFileSync(path.join(dir, 'search-state.json'), JSON.stringify({
    version: 1,
    blockedUntil: TEST_NOW + 30 * 60 * 1000,
    lastBlockAt: TEST_NOW,
    lastBlockStatus: 429,
    entries: [{ key: 'http:https://search.naver.com/search.naver?query=broken', expiresAt: TEST_NOW + 10_000, status: 200, encoding: 'gzip-base64', body: 'not-gzip' }],
  }));
  const result = runNode(dir, `
    const guard = require('./src/scrape/naverSearchGuard');
    guard._setClockForTest(() => ${TEST_NOW});
    let calls = 0;
    guard._setTransportForTest(async () => { calls++; return { status: 200, body: 'fresh' }; });
    guard.guardedSearchFetch('https://search.naver.com/search.naver?query=blocked-fixture').then(
      (response) => console.log(JSON.stringify({ kind: 'resolved', calls, status: response.status })),
      (error) => console.log(JSON.stringify({ kind: error.kind, code: error.code, calls, blocked: guard.getBlockState().blocked }))
    );
  `);
  assert.deepEqual(result, { kind: 'rate_limited', code: 'NAVER_SEARCH_RATE_LIMITED', calls: 0, blocked: true });
});

test('a generic service outage phrase is not treated as an anti-abuse block', () => {
  assert.equal(guard.isBlockPage(200, '현재 서비스가 일시적으로 이용할 수 없습니다'), false);
});

test('a rendered collector 429 preserves its typed cause and suppresses later browser callbacks', async (t) => {
  const dir = createDirectory(t);
  guard.setStorageDir(dir);
  guard._setClockForTest(() => TEST_NOW);
  let calls = 0;
  const collect = async () => {
    calls++;
    throw Object.assign(new Error('rate limit fixture'), { kind: 'rate_limited', status: 429, code: 'NAVER_SEARCH_RATE_LIMITED' });
  };
  await assert.rejects(guard.runGuardedSearch('rendered:https://search.naver.com/search.naver?query=rendered-429', collect), (error) => {
    assert.equal(error.kind, 'rate_limited');
    assert.equal(error.status, 429);
    assert.equal(error.code, 'NAVER_SEARCH_RATE_LIMITED');
    return true;
  });
  await assert.rejects(guard.runGuardedSearch('rendered:https://search.naver.com/search.naver?query=next', collect), (error) => error.kind === 'rate_limited' && error.status === 429);
  assert.equal(calls, 1);
  assert.equal(guard.getBlockState().status, 429);
  guard._resetForTest();
});

test('a rendered collector NaverSearchBlockedError also persists its cooldown', async (t) => {
  const dir = createDirectory(t);
  guard.setStorageDir(dir);
  guard._setClockForTest(() => TEST_NOW);
  let calls = 0;
  const collect = async () => {
    calls++;
    throw new guard.NaverSearchBlockedError({ status: 429, kind: 'rate_limited' });
  };
  await assert.rejects(guard.runGuardedSearch('rendered:https://search.naver.com/search.naver?query=class-429', collect), (error) => error.code === 'NAVER_SEARCH_RATE_LIMITED');
  await assert.rejects(guard.runGuardedSearch('rendered:https://search.naver.com/search.naver?query=class-429-next', collect), (error) => error.kind === 'rate_limited' && error.status === 429);
  assert.equal(calls, 1);
  guard._resetForTest();
});

test('health retains failure kind and HTTP status while preserving the blocked warning contract', () => {
  health.reset();
  health.record('news-headlines', 0, {
    query: 'fixture', status: 429, errorKind: 'rate_limited', blocked: true,
  });
  const snapshot = health.snapshot();
  assert.equal(snapshot['news-headlines'].status, 429);
  assert.equal(snapshot['news-headlines'].errorKind, 'rate_limited');
  assert.equal(health.report().blocked, true);
  assert.match(health.report().message, /네이버 검색/);
});

test('doctor continues independent sources while search.naver.com is paused', async () => {
  assert.equal(typeof (doctorChecks && doctorChecks.runChecks), 'function');
  const calls = [];
  const rows = await doctorChecks.runChecks([
    { id: 'news', label: 'news', min: 1, requiresSearchGuard: true, run: async () => { calls.push('news'); return ['fixture']; } },
    { id: 'autocomplete', label: 'autocomplete', min: 1, requiresSearchGuard: false, run: async () => { calls.push('autocomplete'); return ['fixture']; } },
    { id: 'external', label: 'external', min: 1, run: async () => { calls.push('external'); return ['fixture']; } },
    { id: 'parser', label: 'parser', min: 1, run: async () => [] },
    { id: 'timeout', label: 'timeout', min: 1, run: async () => { throw Object.assign(new Error('timed out'), { kind: 'timeout', status: 503 }); } },
  ], {
    isSearchBlocked: () => true,
    healthSnapshot: () => ({ parser: { errorKind: 'parser_mismatch', resultKind: 'parser_mismatch' } }),
    getBlockState: () => ({ message: 'paused' }),
  });
  assert.deepEqual(calls, ['autocomplete', 'external']);
  assert.equal(rows.find((row) => row.id === 'news').state, 'BLOCKED');
  assert.equal(rows.find((row) => row.id === 'autocomplete').state, 'OK');
  assert.equal(rows.find((row) => row.id === 'external').state, 'OK');
  assert.equal(rows.find((row) => row.id === 'parser').state, 'PARSER_MISMATCH');
  assert.equal(rows.find((row) => row.id === 'timeout').errorKind, 'timeout');
  assert.equal(rows.find((row) => row.id === 'timeout').status, 503);
});

test('doctor counts observed SERP sections instead of reporting a false empty result', async () => {
  const rows = await doctorChecks.runChecks([
    { id: 'serp', label: 'SERP', min: 3, run: async () => ({ sections: ['AI 브리핑', '국어사전', '뉴스'], resultKind: 'ok' }) },
  ], {
    healthSnapshot: () => ({ serp: { resultKind: 'ok' } }),
  });
  assert.equal(rows[0].n, 3);
  assert.equal(rows[0].state, 'OK');
});

test('health reports distinguish parser changes from HTTP and timeout failures', () => {
  health.reset();
  health.record('news-headlines', 0, { errorKind: 'http_error', status: 503, resultKind: 'error' });
  health.record('official-facts', 0, { errorKind: 'timeout', status: 504, resultKind: 'error' });
  health.record('top-titles', 0, { errorKind: 'parser_mismatch', resultKind: 'parser_mismatch' });
  const report = health.report();
  assert.match(report.message, /뉴스 검색.*http_error.*HTTP 503/);
  assert.match(report.message, /기관 페이지 원문.*timeout.*HTTP 504/);
  assert.match(report.message, /상위 제목 참고.*페이지 구조/);
  assert.doesNotMatch(report.message, /네이버 페이지 구조가 바뀌었을 수/);
  health.reset();
});
