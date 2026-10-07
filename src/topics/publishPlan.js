'use strict';
(function () {
// 네이버 예약 발행 계획 검증 + 에디터 전달 파이프라인(주입 → 본문 확인 → 임시저장 → 선택적 예약).
const KST = '+09:00';

function parsePublishPlan(input, now = new Date()) {
  const src = input || {};
  if (src.mode !== 'reserve') return { ok: true, plan: { mode: 'draft' } };
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(src.date || ''));
  const tm = /^(\d{2}):(\d{2})$/.exec(String(src.time || ''));
  if (!dm || !tm) return { ok: false, error: '예약 발행 날짜와 시간을 입력해 주세요.' };
  const [y, mo, da, hh, mi] = [dm[1], dm[2], dm[3], tm[1], tm[2]].map(Number);
  const check = new Date(Date.UTC(y, mo - 1, da, hh, mi));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da || hh > 23 || mi > 59) {
    return { ok: false, error: '존재하지 않는 날짜 또는 시간입니다.' };
  }
  const at = src.date + 'T' + src.time + ':00' + KST;
  if (mi % 10 !== 0) return { ok: false, error: '네이버 예약 시간은 10분 단위(00·10·20·30·40·50)만 선택할 수 있습니다.' };
  if (!(Date.parse(at) > now.getTime())) return { ok: false, error: '예약 시각은 지금(한국 시간)보다 뒤여야 합니다.' };
  return { ok: true, plan: { mode: 'reserve', date: src.date, time: src.time, at } };
}

// 자리표시자(__CPLINK_0__, {{...}}, [[...]])는 주입 중 치환되므로 비교에서 그 앞부분만 쓴다.
const squash = (s) => String(s || '').replace(/\s+/g, '');
const stable = (s) => squash(String(s || '').split(/__[A-Z]+_?\d*__|\{\{|\[\[/)[0]);

// 본문 일부(제목·첫 문단·마지막 문단)가 에디터에 실제로 들어갔는지 비교할 조각.
function expectedFragments(post) {
  const blocks = (post && post.blocks) || [];
  const texts = blocks.filter((b) => b && (b.kind === 'text' || b.kind === 'heading') && stable(b.text).length >= 4).map((b) => stable(b.text));
  const out = [];
  if (post && stable(post.title).length >= 4) out.push(stable(post.title).slice(0, 20));
  if (texts.length) out.push(texts[0].slice(0, 20));
  if (texts.length > 1) out.push(texts[texts.length - 1].slice(0, 20));
  return out;
}

function editorHasFragments(editorText, fragments) {
  const hay = squash(editorText);
  return !!hay && fragments.length > 0 && fragments.every((f) => hay.includes(f));
}

// 원고마다 "새 문서"에 넣는다: 쓰던 내용이 있으면 확인된 임시저장 후 새 글쓰기로 이동하고,
// 이전 문서와 다른 새 문서(표식 토큰 비교)이며 비어 있음을 확인한다. 어느 단계든 실패하면 기존 내용을 지우지 않고 멈춘다.
const POPUP_OPEN_MSG = '네이버 "작성 중인 글이 있습니다" 팝업이 열려 있습니다. 직접 처리한 뒤 다시 시도해 주세요.';

// 주제 탭 진입 검사 — 복구 팝업을 절대 닫지 않는다. 팝업이 있으면 멈추고, 글쓰기 화면이 아니면 열기만 한다.
async function checkEditorEntry({ probePopup, inspect, ensureEditor } = {}) {
  const popupFail = () => ({ ok: false, stage: 'restore-popup-open', detail: POPUP_OPEN_MSG });
  let popup = null;
  try { popup = await probePopup(); } catch (e) { popup = null; }
  if (!popup || popup.present) return popupFail();
  let st = await inspect();
  if ((!st || !st.isEditor) && ensureEditor) {
    try { await ensureEditor(); } catch (e) { /* 아래에서 다시 확인 */ }
    try { popup = await probePopup(); } catch (e) { popup = null; }
    if (!popup || popup.present) return popupFail();
    st = await inspect();
  }
  if (!st || !st.isEditor) return { ok: false, stage: 'not-editor', detail: '네이버 글쓰기 화면을 열지 못했습니다. 오른쪽 화면에서 로그인 상태를 확인해 주세요.' };
  return { ok: true, st };
}

async function prepareFreshEditor({ probePopup, inspect, save, mark, openNew, guard, sleep, ensureEditor } = {}, { maxWait = 30 } = {}) {
  const fail = (stage, detail) => ({ ok: false, stage, detail: detail || stage });
  const entry = await checkEditorEntry({ probePopup, inspect, ensureEditor });
  if (!entry.ok) return fail(entry.stage, entry.detail);
  const st = entry.st;
  // 내용이 비어 있어도 이미 저장된 글의 문서일 수 있으므로(내용만 지운 경우) 항상 새 문서로 이동한다. 저장은 내용이 있을 때만.
  let savedFirst = false;
  if (st.hasContent) {
    const saved = await save();
    if (saved !== 'saved') return fail('save-failed', saved);
    savedFirst = true;
  }
  const oldToken = await mark();
  if (!oldToken) return fail('mark-failed');
  try { await openNew(); } catch (e) { return fail('navigation-failed', (e && e.message) || String(e)); }
  let ns = null;
  for (let i = 0; i < maxWait; i++) {
    ns = await inspect();
    if (ns && ns.isEditor && ns.token !== oldToken) break;
    ns = null;
    await sleep(1000);
  }
  if (!ns) return fail('new-editor-failed', '새 글쓰기 문서로 바뀌지 않았습니다.');
  const g = await guard();
  if (!g || !g.ok) return fail('restore-popup-open', '복구 팝업을 닫지 못했습니다.');
  ns = await inspect();
  if (!ns || !ns.isEditor || ns.token === oldToken || ns.hasContent) return fail('new-editor-failed', '새 문서가 비어 있지 않거나 이전 문서입니다.');
  const token = await mark();
  return token ? { ok: true, fresh: true, token, saved: savedFirst } : fail('mark-failed');
}

// 임시저장 확인: 저장 전에 이미 떠 있던 토스트는 무시하고, 새 토스트이거나 저장 개수 증가일 때만 인정한다. 모르면 실패.
function saveConfirmed({ beforeCount, nowCount, toast, beforeToast } = {}) {
  if (beforeCount != null && nowCount != null && nowCount > beforeCount) return true;
  return !!toast && !beforeToast;
}

function createBusyLock() {
  let busy = false;
  return { tryAcquire() { if (busy) return false; busy = true; return true; }, release() { busy = false; }, busy() { return busy; } };
}

async function deliverToEditor({ plan } = {}, { prepare, inject, verify, save, schedule } = {}) {
  if (prepare) {
    let prep = null;
    try { prep = await prepare(); } catch (e) { prep = { ok: false, stage: 'prepare-error', detail: (e && e.message) || String(e) }; }
    if (!prep || !prep.ok) return { ok: false, stage: 'prepare-failed', detail: (prep && (prep.detail || prep.stage)) || 'prepare-failed' };
  }
  try { await inject(); }
  catch (e) { return { ok: false, stage: 'inject-failed', detail: (e && e.message) || String(e) }; }
  let bodyOk = false;
  try { bodyOk = await verify(); } catch (e) { bodyOk = false; }
  if (!bodyOk) return { ok: false, stage: 'body-missing', detail: '에디터에서 원고 내용을 확인하지 못했습니다.' };
  let saved = '';
  try { saved = await save(); } catch (e) { saved = 'save-error'; }
  if (saved !== 'saved') return { ok: false, stage: 'save-failed', detail: saved };
  if (!plan || plan.mode !== 'reserve') return { ok: true, stage: 'saved' };
  let sched = '';
  try { sched = await schedule(plan); } catch (e) { sched = 'schedule-error'; }
  if (sched !== 'scheduled') return { ok: false, stage: 'schedule-failed', detail: sched };
  return { ok: true, stage: 'scheduled' };
}

const api = { parsePublishPlan, expectedFragments, editorHasFragments, deliverToEditor, prepareFreshEditor, checkEditorEntry, createBusyLock, saveConfirmed };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.topicPublishPlan = api;
})();
