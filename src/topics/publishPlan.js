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

async function deliverToEditor({ plan } = {}, { inject, verify, save, schedule } = {}) {
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

const api = { parsePublishPlan, expectedFragments, editorHasFragments, deliverToEditor };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.topicPublishPlan = api;
})();
