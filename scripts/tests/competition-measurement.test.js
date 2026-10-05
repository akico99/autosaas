const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const { fetchBlogGap } = require('../../src/keyword/competition');
const { scoreCandidate } = require('../../src/keyword/score');

function respondWithResponse(t, statusCode, body) {
  const originalGet = https.get;
  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      callback(response);
      response.emit('data', Buffer.from(body));
      response.emit('end');
    });
    return request;
  };
  t.after(() => { https.get = originalGet; });
}

function blockNetwork(t) {
  const originalGet = https.get;
  https.get = () => { throw new Error('network disabled in test'); };
  t.after(() => { https.get = originalGet; });
}

test('competition dates produce a measured gap with the existing approximate score', async (t) => {
  const latest = Date.UTC(2026, 9, 5);
  blockNetwork(t);
  const body = JSON.stringify({ result: { searchList: [
    { addDate: latest },
    { addDate: latest - 24 * 60 * 60 * 1000 },
    { addDate: latest - 48 * 60 * 60 * 1000 },
  ] } });

  const result = await fetchBlogGap('fixture', { fetchText: async () => body, now: latest });

  assert.deepEqual(result, {
    measured: true,
    gap: 85,
    perDay: 2,
    count: 3,
    spanHours: 48,
    reason: null,
  });
});

test('too few valid competition dates are reported as unmeasured', async (t) => {
  blockNetwork(t);
  const body = JSON.stringify({ result: { searchList: [
    { addDate: Date.UTC(2026, 9, 5) },
    { addDate: Date.UTC(2026, 9, 4) },
  ] } });

  const result = await fetchBlogGap('fixture', { fetchText: async () => body, now: Date.UTC(2026, 9, 5) });

  assert.deepEqual(result, {
    measured: false,
    gap: null,
    perDay: null,
    count: 2,
    spanHours: null,
    reason: 'insufficient_dates',
  });
});

test('a valid empty search list is insufficient data, not a malformed response', async (t) => {
  blockNetwork(t);

  const result = await fetchBlogGap('fixture', {
    fetchText: async () => JSON.stringify({ result: { searchList: [] } }),
    now: Date.UTC(2026, 9, 5),
  });

  assert.deepEqual(result, {
    measured: false,
    gap: null,
    perDay: null,
    count: 0,
    spanHours: null,
    reason: 'insufficient_dates',
  });
});

test('a response without a recognized search list is an invalid response', async (t) => {
  blockNetwork(t);

  const result = await fetchBlogGap('fixture', {
    fetchText: async () => JSON.stringify({ result: {} }),
  });

  assert.deepEqual(result, {
    measured: false,
    gap: null,
    perDay: null,
    count: null,
    spanHours: null,
    reason: 'invalid_response',
  });
});

test('non-finite and implausibly future dates do not count toward a measurement', async (t) => {
  blockNetwork(t);
  const now = Date.UTC(2026, 9, 5);

  const result = await fetchBlogGap('fixture', {
    fetchText: async () => JSON.stringify({ result: { searchList: [
      { addDate: now },
      { addDate: now - 24 * 60 * 60 * 1000 },
      { addDate: 'Infinity' },
      { addDate: Date.UTC(2500, 0, 1) },
    ] } }),
    now,
  });

  assert.deepEqual(result, {
    measured: false,
    gap: null,
    perDay: null,
    count: 2,
    spanHours: null,
    reason: 'insufficient_dates',
  });
});

test('a failed competition request is reported as unmeasured', async (t) => {
  blockNetwork(t);

  const result = await fetchBlogGap('fixture', {
    fetchText: async () => { throw new Error('fixture failure'); },
  });

  assert.deepEqual(result, {
    measured: false,
    gap: null,
    perDay: null,
    count: null,
    spanHours: null,
    reason: 'fetch_failed',
  });
});

test('non-success HTTP responses are reported as unmeasured request failures', async (t) => {
  respondWithResponse(t, 429, JSON.stringify({ result: { searchList: [] } }));

  const result = await fetchBlogGap('fixture');

  assert.deepEqual(result, {
    measured: false,
    gap: null,
    perDay: null,
    count: null,
    spanHours: null,
    reason: 'fetch_failed',
  });
});

test('an unmeasured candidate keeps the neutral ranking weight without exposing a gap', () => {
  const result = scoreCandidate({ gap: null, measured: false });

  assert.equal(result.score, 52);
  assert.equal(result.measured, false);
  assert.equal(result.components.gap, null);
  assert.equal(result.components.gapMeasured, false);
});

test('an actual numeric competition gap retains its prior scoring weight', () => {
  const result = scoreCandidate({ gap: 82, measured: true });

  assert.equal(result.score, 58);
  assert.equal(result.measured, true);
  assert.equal(result.components.gap, 82);
  assert.equal(result.components.gapMeasured, true);
});

test('niche angle request failures stay unmeasured', async (t) => {
  blockNetwork(t);
  const rows = await require('../../src/keyword/niche').findNicheAngles('fixture', {
    limit: 1,
    probe: 1,
    fetchAutocomplete: async () => ['fixture sample'],
    fetchBlogGap: async () => { throw new Error('fixture failure'); },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].gap, null);
  assert.equal(rows[0].measured, false);
  assert.equal(rows[0].reason, 'fetch_failed');
  assert.equal(rows[0].components.gap, null);
  assert.equal(rows[0].components.gapMeasured, false);
});

test('seed radar request failures stay unmeasured', async (t) => {
  blockNetwork(t);
  const rows = await require('../../src/keyword/seedRadar').rankSeeds([
    { keyword: 'fixture' },
  ], {
    gapProbe: 1,
    fetchBlogGap: async () => { throw new Error('fixture failure'); },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].gap, null);
  assert.equal(rows[0].measured, false);
  assert.equal(rows[0].gapInfo.reason, 'fetch_failed');
  assert.equal(rows[0].components.gap, null);
  assert.equal(rows[0].components.gapMeasured, false);
});
