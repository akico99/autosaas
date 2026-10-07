'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareFreshEditor, checkEditorEntry, deliverToEditor, createBusyLock, saveConfirmed } = require('../../src/topics/publishPlan');

// 네이버 에디터 시뮬레이터: 문서(doc) 하나, 임시저장 목록(drafts), 복구 팝업.
function sim({ saveResult = 'saved', navigates = true, restoresDraft = false, startContent = '', popupAtStart = false, notEditor = false, popupAfterEnsure = false } = {}) {
  const s = { n: 1, doc: { id: 1, content: startContent, token: null }, drafts: [], popup: popupAtStart, calls: [], cleared: 0, editor: !notEditor };
  const deps = {
    sleep: async () => {},
    probePopup: async () => ({ present: s.popup }),
    inspect: async () => ({ isEditor: s.editor, hasContent: !!s.doc.content, token: s.doc.token }),
    ensureEditor: async () => { s.calls.push('ensureEditor'); s.editor = true; s.popup = popupAfterEnsure; },
    mark: async () => { s.doc.token = 'tok' + (++s.n); return s.doc.token; },
    save: async () => { s.calls.push('save'); if (saveResult === 'saved' && s.doc.content) s.drafts.push(s.doc.content); return saveResult; },
    openNew: async () => {
      s.calls.push('openNew');
      if (!navigates) return;
      s.doc = { id: s.doc.id + 1, content: restoresDraft ? s.drafts[s.drafts.length - 1] : '', token: null };
      s.popup = s.drafts.length > 0 && !restoresDraft;
    },
    guard: async () => { s.calls.push('guard'); s.popup = false; return { ok: true }; },
  };
  return { s, deps };
}
async function injectInto(s, text, prep) {
  assert.equal(prep.ok, true);
  assert.equal(s.doc.token, prep.token, 'injection must target the marked fresh document');
  assert.equal(s.doc.content, '', 'fresh editor must be blank at injection');
  s.doc.content = text;
}

test('two successive drafts: first saved draft is preserved, second goes to a new document', async () => {
  const { s, deps } = sim();
  let prep = await prepareFreshEditor(deps);
  assert.deepEqual(s.calls, ['openNew', 'guard'], 'empty editor: no save, but still a new document');
  await injectInto(s, '첫 번째 원고', prep);
  s.drafts.push(s.doc.content); // 첫 원고 임시저장(전달 파이프라인)
  const firstDocId = s.doc.id;
  prep = await prepareFreshEditor(deps);
  assert.equal(prep.ok, true);
  assert.ok(s.doc.id !== firstDocId, 'a new document replaced the saved one');
  await injectInto(s, '두 번째 원고', prep);
  assert.deepEqual(s.drafts.filter((x) => x === '첫 번째 원고').length >= 1, true);
  assert.ok(s.drafts.includes('첫 번째 원고'));
  assert.equal(s.doc.content, '두 번째 원고');
});

test('unsaved editor content is saved before navigating, and not saved twice', async () => {
  const { s, deps } = sim({ startContent: '사용자가 쓰던 글' });
  const prep = await prepareFreshEditor(deps);
  assert.equal(prep.ok, true);
  assert.deepEqual(s.calls.filter((c) => c === 'save'), ['save']);
  assert.ok(s.calls.indexOf('save') < s.calls.indexOf('openNew'));
  assert.deepEqual(s.drafts, ['사용자가 쓰던 글']);
});

test('save failure aborts without navigating or touching content', async () => {
  const { s, deps } = sim({ startContent: '지키는 글', saveResult: 'save-unconfirmed' });
  const prep = await prepareFreshEditor(deps);
  assert.equal(prep.ok, false); assert.equal(prep.stage, 'save-failed');
  assert.ok(!s.calls.includes('openNew'));
  assert.equal(s.doc.content, '지키는 글');
});

test('navigation that never produces a new document aborts without clearing', async () => {
  const { s, deps } = sim({ startContent: '지키는 글', navigates: false });
  const prep = await prepareFreshEditor(deps, { maxWait: 3 });
  assert.equal(prep.ok, false); assert.equal(prep.stage, 'new-editor-failed');
  assert.equal(s.doc.content, '지키는 글');
});

test('a new document that restores old content is rejected', async () => {
  const { s, deps } = sim({ startContent: '복구될 글', restoresDraft: true });
  const prep = await prepareFreshEditor(deps, { maxWait: 3 });
  assert.equal(prep.ok, false); assert.equal(prep.stage, 'new-editor-failed');
});

test('an empty editor is never saved, but still moves to a new document', async () => {
  const { s, deps } = sim({ startContent: '' });
  const firstId = s.doc.id;
  const prep = await prepareFreshEditor(deps);
  assert.equal(prep.ok, true);
  assert.ok(!s.calls.includes('save'));
  assert.ok(s.doc.id !== firstId);
});

test('not on the editor: it is opened first, and a popup that appears then fails without clicking', async () => {
  let { s, deps } = sim({ notEditor: true });
  let prep = await prepareFreshEditor(deps);
  assert.equal(prep.ok, true);
  assert.equal(s.calls[0], 'ensureEditor');
  ({ s, deps } = sim({ notEditor: true, popupAfterEnsure: true }));
  prep = await prepareFreshEditor(deps);
  assert.equal(prep.ok, false); assert.equal(prep.stage, 'restore-popup-open');
  assert.ok(!s.calls.includes('guard'));
});

test('stale save toast is not a confirmation; a fresh toast or a count increase is', () => {
  assert.equal(saveConfirmed({ beforeCount: 2, nowCount: 2, toast: true, beforeToast: true }), false);
  assert.equal(saveConfirmed({ beforeCount: 2, nowCount: 2, toast: false, beforeToast: false }), false);
  assert.equal(saveConfirmed({ beforeCount: 2, nowCount: null, toast: false, beforeToast: false }), false);
  assert.equal(saveConfirmed({ beforeCount: 2, nowCount: 2, toast: true, beforeToast: false }), true);
  assert.equal(saveConfirmed({ beforeCount: 2, nowCount: 3, toast: false, beforeToast: true }), true);
});

test('generation entry check never dismisses an initial restore popup', async () => {
  const clicks = [];
  const r = await checkEditorEntry({ probePopup: async () => ({ present: true }), inspect: async () => ({ isEditor: true }), ensureEditor: async () => { clicks.push('open'); } });
  assert.equal(r.ok, false); assert.equal(r.stage, 'restore-popup-open'); assert.deepEqual(clicks, []);
});

test('generation entry check opens the editor only when not on it, then re-checks the popup', async () => {
  let editor = false; const calls = [];
  const ok = await checkEditorEntry({ probePopup: async () => ({ present: false }), inspect: async () => ({ isEditor: editor }), ensureEditor: async () => { calls.push('open'); editor = true; } });
  assert.equal(ok.ok, true); assert.deepEqual(calls, ['open']);
  const bad = await checkEditorEntry({ probePopup: async () => ({ present: false }), inspect: async () => ({ isEditor: false }), ensureEditor: async () => {} });
  assert.equal(bad.ok, false); assert.equal(bad.stage, 'not-editor');
});

test('app generation start uses the nondestructive entry check', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../app/app.html'), 'utf8');
  const gen = html.slice(html.indexOf("byId('topic-generate').addEventListener"), html.indexOf('원고 전략 한 줄'));
  assert.match(gen, /await topicEntryCheck\(\);/);
  assert.doesNotMatch(gen, /ensureEditorPage\(/);
  assert.match(html, /ensureEditor:openEditorNoDismiss/);
  assert.match(html, /var _NV_INSPECT=window\.topicEditorGuard\.INSPECT_SCRIPT;/);
});

test('an open restore popup at start fails without clicking anything', async () => {
  const { s, deps } = sim({ popupAtStart: true, startContent: 'x' });
  const prep = await prepareFreshEditor(deps);
  assert.equal(prep.ok, false); assert.equal(prep.stage, 'restore-popup-open');
  assert.deepEqual(s.calls, []);
});

test('delivery stops before injection when the fresh editor cannot be prepared', async () => {
  const calls = [];
  const r = await deliverToEditor({ plan: { mode: 'draft' } }, {
    prepare: async () => ({ ok: false, stage: 'save-failed', detail: 'save-unconfirmed' }),
    inject: async () => { calls.push('inject'); }, verify: async () => true, save: async () => 'saved',
  });
  assert.equal(r.ok, false); assert.equal(r.stage, 'prepare-failed'); assert.deepEqual(calls, []);
});

test('busy lock blocks overlapping generation and stored-draft injection', () => {
  const lock = createBusyLock();
  assert.equal(lock.tryAcquire(), true);
  assert.equal(lock.tryAcquire(), false);
  lock.release();
  assert.equal(lock.tryAcquire(), true);
});

test('app prepares a fresh editor, shares one lock, and skips clearing a prepared editor', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../app/app.html'), 'utf8');
  assert.match(html, /prepare:function\(\)\{ return prepareTopicEditor\(\); \}/);
  assert.match(html, /topicLock\.tryAcquire\(\)/);
  assert.match(html, /opts\.freshToken/);
  assert.match(html, /if\(!opts\.freshToken\)\{ setSt\('이전 글 정리 중…'\)/);
});
