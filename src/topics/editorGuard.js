'use strict';
(function () {
// 네이버 에디터의 "작성 중인 글이 있습니다" 복구 팝업 가드.
// 실제 DOM(2026-10 확인): .se-popup.se-popup-alert-confirm > strong.se-popup-title, 취소 = .se-popup-button-cancel.
// 이 팝업 위에서 전체선택·삭제·입력이 일어나면 안 되므로, 편집 전에 반드시 닫힘을 확인한다. 다른 대화상자의 '취소'는 건드리지 않는다.
const POPUP_PROBE_SCRIPT = "(function(){var re=/작성\\s*중인\\s*글/;function scan(d,ox,oy){if(!d)return null;var ps=[].slice.call(d.querySelectorAll('.se-popup'));for(var i=0;i<ps.length;i++){var p=ps[i];var r=p.getBoundingClientRect();if(r.width<=0||r.height<=0)continue;var t=p.querySelector('.se-popup-title');if(!t||!re.test(t.textContent||''))continue;var c=p.querySelector('.se-popup-button-cancel');var cr=c&&c.getBoundingClientRect();return {present:true,cancel:(cr&&cr.width>0)?{x:ox+cr.x+cr.width/2,y:oy+cr.y+cr.height/2}:null};}return null;}var a=scan(document,0,0);if(a)return a;var f=document.getElementById('mainFrame');if(f){var d;try{d=f.contentDocument;}catch(e){d=null;}if(d){var fr=f.getBoundingClientRect();var b=scan(d,fr.x,fr.y);if(b)return b;}}return {present:false};})()";

async function clearRestorePopup({ probe, click, sleep } = {}, { maxTries = 5 } = {}) {
  let clicks = 0;
  for (let i = 0; i < maxTries; i++) {
    let st = null;
    try { st = await probe(); } catch (e) { st = null; }
    if (!st) return { ok: false, clicks, detail: 'probe-failed' };
    if (!st.present) return { ok: true, clicks };
    if (!st.cancel) return { ok: false, clicks, detail: 'no-cancel-button' };
    await click(Math.round(st.cancel.x), Math.round(st.cancel.y));
    clicks += 1;
    await sleep(700);
  }
  let last = null;
  try { last = await probe(); } catch (e) { last = null; }
  if (last && last.present === false) return { ok: true, clicks };
  return { ok: false, clicks, detail: 'popup-still-open' };
}

const api = { clearRestorePopup, POPUP_PROBE_SCRIPT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.topicEditorGuard = api;
})();
