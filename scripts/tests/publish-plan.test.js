'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePublishPlan, deliverToEditor, expectedFragments, editorHasFragments } = require('../../src/topics/publishPlan');
const { injectTopicPost } = require('../../src/topics/editorDelivery');

const NOW = new Date('2026-10-07T00:00:00Z'); // 09:00 KST

test('default plan is a temporary save and needs no date', () => {
  assert.deepEqual(parsePublishPlan({}, NOW), { ok: true, plan: { mode: 'draft' } });
});

test('reservation is validated in Asia/Seoul before any generation', () => {
  const ok = parsePublishPlan({ mode: 'reserve', date: '2026-10-07', time: '10:30' }, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.plan.at, '2026-10-07T10:30:00+09:00');
  for (const bad of [
    { mode: 'reserve', date: '', time: '10:30' },
    { mode: 'reserve', date: '2026-02-30', time: '10:30' },
    { mode: 'reserve', date: '2026-10-07', time: '25:00' },
    { mode: 'reserve', date: '2026-10-07', time: '09:00' },
    { mode: 'reserve', date: '2026-10-06', time: '23:00' },
  ]) {
    const r = parsePublishPlan(bad, NOW);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.error);
  }
});

const post = { title: '인터넷사주 확인법', blocks: [
  { kind: 'text', text: '첫 문단입니다.' }, { kind: 'heading', text: '소제목' }, { kind: 'text', text: '마지막 문단입니다.' },
] };

test('short legitimate posts are verified by content, not paragraph count', () => {
  const frags = expectedFragments(post);
  assert.ok(frags.length >= 2);
  assert.equal(editorHasFragments('인터넷사주 확인법 첫 문단입니다. 소제목 마지막 문단입니다.', frags), true);
  assert.equal(editorHasFragments('이전 글의 다른 내용 마지막 문단입니다.', frags), false);
  assert.equal(editorHasFragments('', frags), false);
});

function steps(over = {}) {
  const calls = [];
  return { calls, deps: Object.assign({
    inject: async () => { calls.push('inject'); },
    verify: async () => { calls.push('verify'); return true; },
    save: async () => { calls.push('save'); return 'saved'; },
    schedule: async () => { calls.push('schedule'); return 'scheduled'; },
  }, over) };
}

test('default delivery injects, verifies, then temporarily saves; never schedules', async () => {
  const { calls, deps } = steps();
  const r = await deliverToEditor({ plan: { mode: 'draft' } }, deps);
  assert.deepEqual(calls, ['inject', 'verify', 'save']);
  assert.equal(r.ok, true); assert.equal(r.stage, 'saved');
});

test('failed injection or missing body stops before save', async () => {
  let s = steps({ inject: async () => { throw new Error('붙여넣기 실패'); } });
  let r = await deliverToEditor({ plan: { mode: 'draft' } }, s.deps);
  assert.equal(r.ok, false); assert.equal(r.stage, 'inject-failed'); assert.deepEqual(s.calls, []);
  s = steps({ verify: async () => false });
  r = await deliverToEditor({ plan: { mode: 'draft' } }, s.deps);
  assert.equal(r.ok, false); assert.equal(r.stage, 'body-missing'); assert.deepEqual(s.calls, ['inject']);
});

test('unconfirmed save blocks scheduling and reports failure', async () => {
  const s = steps({ save: async () => 'save-unconfirmed' });
  const r = await deliverToEditor({ plan: { mode: 'reserve', at: 'x' } }, s.deps);
  assert.equal(r.ok, false); assert.equal(r.stage, 'save-failed');
  assert.ok(!s.calls.includes('schedule'));
});

test('reservation schedules only after save and reports scheduler failures', async () => {
  let s = steps();
  let r = await deliverToEditor({ plan: { mode: 'reserve', at: '2026-10-07T10:30:00+09:00' } }, s.deps);
  assert.deepEqual(s.calls, ['inject', 'verify', 'save', 'schedule']);
  assert.equal(r.ok, true); assert.equal(r.stage, 'scheduled');
  s = steps({ schedule: async () => 'schedule-ui-not-found' });
  r = await deliverToEditor({ plan: { mode: 'reserve', at: 'x' } }, s.deps);
  assert.equal(r.ok, false); assert.equal(r.stage, 'schedule-failed'); assert.equal(r.detail, 'schedule-ui-not-found');
});

test('topic injection propagates finishGen failure', async () => {
  await assert.rejects(() => injectTopicPost({ post, assets: [], purpose: 'search', keyword: 'k',
    finishGen: async () => ({ ok: false, error: '본문 주입 실패' }) }), /본문 주입 실패/);
  const r = await injectTopicPost({ post, assets: [], purpose: 'search', keyword: 'k', finishGen: async () => ({ ok: true }) });
  assert.equal(r.keyword, 'k');
});

test('template tokens are excluded from verification fragments', () => {
  assert.equal(parsePublishPlan({ mode: 'reserve', date: '2026-10-07', time: '10:35' }, NOW).ok, false);
  assert.equal(parsePublishPlan({ mode: 'reserve', date: '2026-10-07', time: '10:40' }, NOW).ok, true);
  assert.doesNotMatch(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../app/app.html'), 'utf8'), /title:t1\b/);
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '../../app/app.html'), 'utf8');
  assert.match(html, /async function deliverTopic\(result,purpose,keyword,parsedPlan\)\{\s*var plan=parsedPlan&&parsedPlan\.plan;/);
  assert.match(html, /deliverTopic\(result,purpose,keyword,pubPlan\)/);
  assert.match(html, /deliverTopic\(d\.result,d\.purpose,d\.keyword,dPlan\)/);
  const frags = expectedFragments({ title: '제목입니다 확인', blocks: [{ kind: 'text', text: '앞부분 문장__CPLINK_0__뒤' }] });
  assert.ok(frags.every((f) => !f.includes('CPLINK')));
  assert.equal(editorHasFragments('제목입니다 확인 앞부분 문장 카드 뒤', frags), true);
});
