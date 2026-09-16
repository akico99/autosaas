// 구글 트렌드(실시간, 48시간) 스크래퍼 — 검색량·급상승·시간·연관어를 통째로 가져온다.
//
// ★배포 안전: 무키·무로그인. 단 JS 렌더 페이지라 Electron 웹뷰에서 렌더 후 추출해야 한다
//   (main.js가 scrapeRendered로 GT_URL을 렌더 → GT_EXTRACT 실행 → JSON 파싱).
//   내부 batchexecute API는 세션토큰·난독포맷이라 배포용으론 불안정 → DOM 텍스트 추출이 안전.

const GT_URL = 'https://trends.google.co.kr/trending?geo=KR&hours=48';

// 렌더된 페이지에서 실행할 추출 스크립트(브라우저에서 실제 검증됨).
//   각 행(role="row") 6칸: [체크박스, 키워드, "검색량 급상승%", "시간 상태", 연관어, 빈칸].
//   "정평정평"처럼 두 번 반복된 연관어는 반띵(undouble)으로 정리.
const GT_EXTRACT = `(function(){
  function volNum(s){var m=s.match(/([0-9,]+)\\s*([만천])/);if(!m)return 0;var n=parseInt(m[1].replace(/,/g,''),10);return m[2]==='만'?n*10000:n*1000;}
  function undouble(s){var h=s.length/2;return (s.length%2===0 && h>0 && s.slice(0,h)===s.slice(h))?s.slice(0,h):s;}
  var rows=[].slice.call(document.querySelectorAll('[role="row"]'));
  var out=[];
  rows.forEach(function(r){
    var c=[].slice.call(r.children).map(function(x){return (x.innerText||'').replace(/\\s+/g,' ').trim();});
    if(c.length<5) return;
    var kw=c[1]; if(!kw||/검색량|시작일|트렌드/.test(c.join(''))) return;
    var vol=volNum(c[2]||'');
    var rise=parseInt(((c[2]||'').match(/([0-9,]+)%/)||[])[1]||'0',10);
    var time=(c[3]||'').replace(/trending_up|활성/g,'').trim();
    var relRaw=(c[4]||'').replace(/검색어query_stats탐색/g,'|').replace(/외 \\d+개/g,'').split('|');
    var seen={},rel=[];
    relRaw.forEach(function(t){t=undouble(t.trim());if(t&&!seen[t]){seen[t]=1;rel.push(t);}});
    out.push({keyword:kw,volume:vol,risePct:rise,time:time,related:rel.slice(0,6),source:'google-trends'});
  });
  return JSON.stringify(out.slice(0,80));
})()`;

module.exports = { GT_URL, GT_EXTRACT };
