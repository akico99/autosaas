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

// 에디터 상태 읽기(페이지 안에서 실행되는 순수 DOM 함수). 플레이스홀더 노드([class*=placeholder])만 빼고 남은 글자가 있으면 내용 있음 —
// 실제 제목이 정확히 '제목'이어도 플레이스홀더 노드가 아니라면 내용으로 본다(보수적: 애매하면 저장).
function inspectEditorDocument(d) {
  if (!d || !d.querySelector('.se-content, .se-title-text')) return { isEditor: false };
  var has = false;
  [].slice.call(d.querySelectorAll('.se-text-paragraph')).forEach(function (p) {
    var c = p.cloneNode(true);
    [].slice.call(c.querySelectorAll('[class*=placeholder]')).forEach(function (x) { x.remove(); });
    if ((c.textContent || '').replace(/[\s\u200b]+/g, '').length > 0) has = true;
  });
  if (!has && d.querySelector('.se-component.se-image, .se-component.se-oglink, .se-component.se-map, .se-component.se-table, .se-component.se-video, .se-component.se-file, .se-component.se-quotation, .se-component.se-horizontalLine, .se-component.se-code, .se-component.se-sticker')) has = true;
  return { isEditor: true, hasContent: has, token: d.__baFresh || null };
}
const INSPECT_SCRIPT = "(function(){var f=document.getElementById('mainFrame');if(!f)return {isEditor:false};var d=null;try{d=f.contentDocument;}catch(e){}return (" + inspectEditorDocument.toString() + ")(d);})()";

const api = { clearRestorePopup, POPUP_PROBE_SCRIPT, inspectEditorDocument, INSPECT_SCRIPT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.topicEditorGuard = api;
})();
