'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const daily = require('../../src/connect/daily');
const discover = require('../../src/connect/discover');
const telegram = require('../../src/notify/telegram');
const quickPost = require('../../src/connect/quickPost');

test('Telegram send splits HTML and uses the expected sendMessage payload', async () => {
  const calls = [];
  const result = await telegram.sendTelegram({ token: 'secret-token', chatId: '77', text: '가'.repeat(8001) }, { request: async (url, body) => { calls.push({ url, body }); return { ok: true }; } });
  assert.equal(calls.length, 3); assert.equal(result.sent, 3);
  assert.match(calls[0].url, /botsecret-token\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, '77'); assert.equal(calls[0].body.parse_mode, 'HTML'); assert.equal(calls[0].body.disable_web_page_preview, true);
  assert.ok(calls.every((call) => call.body.text.length <= 3900));
});

test('Telegram converts report HTML breaks to supported message newlines', async () => {
  const calls = [];
  await telegram.sendTelegram({ token: 'test-token', chatId: '77', text: '첫째 줄<br>둘째 줄<br/>셋째 줄' }, { request: async (_url, body) => { calls.push(body); return { ok: true }; } });
  assert.equal(calls[0].text, '첫째 줄\n둘째 줄\n셋째 줄');
  assert.equal(calls[0].parse_mode, 'HTML');
});

test('Telegram findChatId selects the latest message chat', async () => {
  const found = await telegram.findChatId('x', { request: async () => ({ ok: true, result: [
    { update_id: 1, message: { chat: { id: 12, first_name: 'A' } } },
    { update_id: 2, message: { chat: { id: -5, title: 'My group' } } },
  ] }) });
  assert.deepEqual(found, { chatId: '-5', name: 'My group' });
});

test('queue add trims, deduplicates active links, and daily selection fills targets with oldest unknowns', () => {
  const queue = [{ id: 'old', url: 'https://naver.me/old', addedAt: '2026-01-01', kind: null, status: 'queued' }];
  let seq = 0;
  const added = daily.addQueueUrls(queue, [' https://naver.me/old ', 'https://smartstore.naver.com/x', 'http://naver.me/no', 'https://product.example/item'], { id: () => `new${++seq}`, now: () => '2026-01-02' });
  assert.equal(added.added, 2); assert.equal(added.items[1].url, 'https://smartstore.naver.com/x');
  const picked = daily.pickDailyItems([
    ...added.items,
    { id: 't', kind: 'travel', status: 'queued', addedAt: '2026-01-03' },
    { id: 's', kind: 'shopping', status: 'queued', addedAt: '2026-01-04' },
  ]);
  assert.deepEqual(picked.map((x) => x.id), ['old', 'new1', 'new2', 't']);
});

test('daily report contains counts, shortage, discovery items, and escaped HTML', () => {
  const report = daily.buildReport({ results: [{ kind: 'travel', status: 'done', title: '<여행>', keyword: '부산 & 대마도' }], queueLeft: [
    { kind: 'travel', status: 'queued' }, { kind: null, status: 'queued' },
  ], discovery: { travel: [{ name: '<대마도>', price: '2만원', why: '인기 & 구성', keyword: '대마도 여행 추천' }] } }, new Date(2026, 0, 2));
  assert.match(report, /오늘의 커넥트 원고 \(01\/02\)/); assert.match(report, /여행 1 \/ 쇼핑 0 \/ 미분류 1/);
  assert.match(report, /대기 링크가 부족해 1편만 만들었습니다/); assert.match(report, /&lt;대마도&gt;/); assert.match(report, /인기 &amp; 구성/);
});

test('daily report accepts renderer ok results and prefers the saved draft title', () => {
  const report = daily.buildReport({ results: [{ ok: true, kind: 'travel', title: '상품 제목', draftTitle: '임시저장 제목', keyword: '부산 여행' }] }, new Date(2026, 0, 2));
  assert.match(report, /✅ 여행 · 임시저장 제목 · 부산 여행/);
  assert.doesNotMatch(report, /❌ 여행/);
});

test('auto keyword planner validates Opus choice and falls back to first candidate', async () => {
  const calls = [];
  const generated = await quickPost.runQuickGeneration({ keyword: 'auto', analysis: {
    facts: { name: '상품', price: '20,000원' }, keywords: [{ keyword: '부산 대마도 여행' }, { keyword: '대마도 배편' }], images: [],
    product: { title: '부산 대마도', priceText: '20,000원' }, kind: 'travel', issuedUrl: 'https://naver.me/test',
  }, run: async (params) => {
    calls.push(params);
    if (params.phase === 'planner') return { text: JSON.stringify({ keyword: '후보에 없는 검색어', titleType: 'A', title: '부산 대마도 여행 20,000원', hook: ['안내합니다'], summary: [], sections: [], fit: {}, questions: [], closing: '확인하세요' }) };
    return { text: JSON.stringify({ title: '임시 제목', blocks: [{ kind: 'text', text: '상품 안내입니다.' }] }) };
  } });
  assert.equal(generated.chosenKeyword, '부산 대마도 여행');
  assert.match(generated.assembled.post.title, /부산 대마도 여행/);
  assert.match(calls[0].user, /후보 중 가장 판매 가능성이 높은/);
  assert.match(calls[1].user, /부산 대마도 여행/);
});

test('discovery parse accepts fenced JSON and safely falls back on malformed data', () => {
  assert.deepEqual(discover.parseDiscoveryResponse('```json\n{"travel":[{"name":"상품","price":"10원","why":"추천","keyword":"여행 추천"}]}\n```'), {
    travel: [{ name: '상품', price: '10원', why: '추천', keyword: '여행 추천' }], shopping: [],
  });
  assert.deepEqual(discover.parseDiscoveryResponse('oops'), { travel: [], shopping: [] });
});
