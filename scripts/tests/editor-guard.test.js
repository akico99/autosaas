'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { clearRestorePopup, POPUP_PROBE_SCRIPT } = require('../../src/topics/editorGuard');

function fakeEditor({ popup = true, stubborn = false, latePopupAfterClicks = 0 } = {}) {
  const s = { popup, clicks: [], probes: 0, lateLeft: latePopupAfterClicks };
  return {
    s,
    probe: async () => { s.probes += 1; return s.popup ? { present: true, cancel: { x: 321, y: 123 } } : { present: false }; },
    click: async (x, y) => {
      s.clicks.push([x, y]);
      if (!stubborn) s.popup = false;
      if (s.lateLeft > 0 && !s.popup) { s.lateLeft -= 1; s.popup = true; }
    },
    sleep: async () => {},
  };
}

test('restore popup already on the editor is cancelled at its own cancel button', async () => {
  const ed = fakeEditor();
  const r = await clearRestorePopup(ed);
  assert.equal(r.ok, true);
  assert.deepEqual(ed.s.clicks, [[321, 123]]);
});

test('no popup means no click', async () => {
  const ed = fakeEditor({ popup: false });
  const r = await clearRestorePopup(ed);
  assert.equal(r.ok, true);
  assert.deepEqual(ed.s.clicks, []);
});

test('a popup that reappears late is dismissed again and verified gone', async () => {
  const ed = fakeEditor({ latePopupAfterClicks: 1 });
  const r = await clearRestorePopup(ed);
  assert.equal(r.ok, true);
  assert.equal(ed.s.clicks.length, 2);
  assert.equal(ed.s.popup, false);
});

test('a popup that will not close fails instead of reporting ready', async () => {
  const ed = fakeEditor({ stubborn: true });
  const r = await clearRestorePopup(ed, { maxTries: 3 });
  assert.equal(r.ok, false);
  assert.equal(ed.s.clicks.length, 3);
});

test('popup without a cancel button is a failure and clicks nothing', async () => {
  const r = await clearRestorePopup({ probe: async () => ({ present: true, cancel: null }), click: async () => { throw new Error('clicked'); }, sleep: async () => {} });
  assert.equal(r.ok, false);
});

test('probe script is scoped to the restore popup, not any 취소 button', () => {
  assert.match(POPUP_PROBE_SCRIPT, /se-popup-button-cancel/);
  assert.ok(POPUP_PROBE_SCRIPT.includes('작성\\s*중인\\s*글'));
  assert.match(POPUP_PROBE_SCRIPT, /se-popup-title/);
});

test('app wires the guard before editor reuse, clearing and title input', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../app/app.html'), 'utf8');
  assert.match(html, /async function ensureEditorPage\(setSt\)\{\s*if\(await isOnEditorPage\(\)\)\{ return \(await guardRestorePopup\(\)\)\.ok; \}/);
  assert.match(html, /async function clearEditorBody\(\)\{\s*if\(!\(await guardRestorePopup\(\)\)\.ok\) throw/);
  assert.match(html, /for\(let _ta=0; _ta<4 && _tval && !_ok; _ta\+\+\)\{\s*if\(!\(await guardRestorePopup\(\)\)\.ok\) throw/);
  assert.match(html, /editorGuard\.js/);
});
