'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const appHtml = fs.readFileSync(path.join(root, 'app/app.html'), 'utf8');
const start = appHtml.indexOf('window._travelConnectHooks={');
const end = appHtml.indexOf('// 글쓰기 화면 열기만', start);
assert.ok(start >= 0 && end > start, 'real travel delivery hook must be present in app.html');
const hookSource = appHtml.slice(start, end);
const deliverySource = fs.readFileSync(path.join(root, 'src/topics/editorDelivery.js'), 'utf8');
const disclosure = require('../../src/connect/policy').getConnectDisclosure('travel');
const rawUrl = 'https://travel.example.test/go?a=1&a=2+3#room';

function makeHarness({ second = {}, confirmResult = true, finalPost = null } = {}) {
  const post = { title: '여행 비교', blocks: [{ kind: 'text', text: disclosure }, { kind: 'link', text: '상품', href: rawUrl }] };
  const context = { connectKind: 'travel', disclosureLine: disclosure, links: [{ affiliateUrlRaw: rawUrl }], productSnapshots: [], sources: [] };
  const baseline = { ok: true, status: 'review', reviewReasons: ['사람이 확인해야 합니다.'], holdReasons: [], draft: { result: { connect: context } }, result: { post, connect: context } };
  const latest = { ...baseline, ...second };
  const win = {
    _myPhotos: ['legacy-photo'], _placePhotos: ['legacy-place'], _genType: 'legacy', _genCtx: 'home', _topicTabActive: false, _topicId: 'saju',
    _reviewDiscType: 'mine', _reviewDiscItem: 'legacy item', _topicStatusEl: { old: true },
    api: { connectPrepareDelivery: async ({ id }) => { assert.equal(id, 'saved-draft'); return apiCalls++ === 0 ? baseline : latest; } },
    topicEditorDelivery: null,
    travelConnectUI: require('../../src/topics/travelConnect'),
  };
  let apiCalls = 0, injected = 0, reviewAtFinish = 'not-called', imagePrepComplete = false;
  const lock = { held: false, busy() { return this.held; }, tryAcquire() { if (this.held) return false; this.held = true; return true; }, release() { this.held = false; } };
  const document = { body: { classList: { toggle() {} } }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const contextVm = {
    window: win, document, topicLock: lock, confirm: () => confirmResult,
    byId: () => ({ getURL: () => 'http://local/editor' }),
    prepareTopicEditor: async () => ({ ok: true }), verifyEditorPost: async () => true,
    finishGen: async (nextPost, _keyword, _links, _ads, options) => {
      imagePrepComplete = true;
      reviewAtFinish = win._reviewDiscType;
      if (options.beforeInject) await options.beforeInject(finalPost || nextPost);
      injected++;
      return { ok: true };
    },
  };
  vm.createContext(contextVm);
  vm.runInContext(deliverySource, contextVm, { filename: 'src/topics/editorDelivery.js' });
  vm.runInContext(hookSource, contextVm, { filename: 'app/app.html travel hook' });
  return {
    win, lock, get injected() { return injected; }, get apiCalls() { return apiCalls; }, get reviewAtFinish() { return reviewAtFinish; },
    get imagePrepComplete() { return imagePrepComplete; },
    async deliver() { const initial=await win.api.connectPrepareDelivery({id:'saved-draft'}); return win._travelConnectHooks.deliver(postResult(), { id: 'saved-draft', keyword: '여행 비교' }, { allowedUrls: [rawUrl] }, [], { reviewReasons: initial.reviewReasons }); },
  };
  function postResult() { return { post, assets: [] }; }
}

test('app travel hook rechecks the saved draft after image prep, injects, and restores globals/lock', async () => {
  const harness = makeHarness();
  await harness.deliver();
  assert.equal(harness.apiCalls, 2);
  assert.equal(harness.imagePrepComplete, true);
  assert.equal(harness.reviewAtFinish, null);
  assert.equal(harness.injected, 1);
  assert.equal(harness.lock.held, false);
  assert.equal(harness.win._myPhotos[0], 'legacy-photo');
  assert.equal(harness.win._placePhotos[0], 'legacy-place');
  assert.equal(harness.win._genType, 'legacy');
  assert.equal(harness.win._genCtx, 'home');
  assert.equal(harness.win._topicId, 'saju');
  assert.equal(harness.win._reviewDiscType, 'mine');
  assert.equal(harness.win._reviewDiscItem, 'legacy item');
});

test('app travel hook proceeds only after confirming newly added review reasons', async () => {
  const harness = makeHarness({ second: { reviewReasons: ['새 검수 항목'] }, confirmResult: true });
  await harness.deliver();
  assert.equal(harness.apiCalls, 2);
  assert.equal(harness.injected, 1);
  assert.equal(harness.lock.held, false);
});

test('app travel hook fails closed on late hold, changed post, new review reasons, or altered URL', async () => {
  const differentPost = { title: 'edited elsewhere', blocks: [] };
  const cases = [
    { name: 'late hold', second: { ok: false, status: 'hold', holdReasons: ['가격 확인 만료'] }, reason: /가격 확인 만료/ },
    { name: 'concurrent edit', second: { result: { post: differentPost } }, reason: /수정/ },
    { name: 'changed review requiring confirmation', second: { reviewReasons: ['새 검수 항목'] }, confirmResult: false, reason: /취소/ },
  ];
  for (const scenario of cases) {
    const harness = makeHarness(scenario);
    await assert.rejects(harness.deliver(), scenario.reason, scenario.name);
    assert.equal(harness.injected, 0, scenario.name);
    assert.equal(harness.lock.held, false, scenario.name);
    assert.equal(harness.win._reviewDiscType, 'mine', scenario.name);
  }
  const altered = makeHarness({ finalPost: { title: 'bad', blocks: [{ kind: 'text', text: disclosure }, { kind: 'link', href: rawUrl + '&extra=1' }] } });
  await assert.rejects(altered.deliver(), /제휴 링크 원문|변경된 제휴 링크|등록된 출처/);
  assert.equal(altered.injected, 0);
  assert.equal(altered.lock.held, false);
});
