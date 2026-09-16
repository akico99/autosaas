// ★네이버·외부 사이트 "마크업 의존부"를 한 곳에 모은 파일.
//
// 왜 한 파일인가:
//   네이버가 검색결과·랭킹 페이지의 클래스명을 바꾸면 수집이 전부 조용히 0건이 된다
//   (각 수집 함수가 catch → [] 라 에러도 안 난다). 셀렉터가 여기저기 박혀 있으면
//   "어디가 깨졌는지" 찾는 데만 한참 걸린다. 그래서 깨질 수 있는 것은 전부 여기 둔다.
//
// 깨졌을 때 고치는 순서:
//   1) `npm run doctor` 로 어느 소스가 0건인지 확인 (scripts/doctor.js)
//   2) 아래 상수 중 그 소스의 셀렉터를 실제 페이지에서 다시 찾아 고친다
//      (구조 파악용 덤프 스크립트 DISCOVER_DUMP 를 쓰면 리스트 후보가 나온다)
//   3) 고친 뒤 다시 doctor 로 확인
//
// 종류:
//   A. HTML 정규식 — Node에서 받은 HTML 문자열을 직접 파싱 (검색결과·기사)
//   B. 페이지 실행 스크립트 — Electron 숨은 창에서 executeJavaScript 로 실행 (JS 렌더 페이지)

// ─────────────────────────────────────────────────────────────
// A. HTML 정규식
// ─────────────────────────────────────────────────────────────

// 네이버 통합검색(뉴스·블로그) 결과의 텍스트 컴포넌트 클래스.
// 예) <span class="sds-comps-text sds-comps-text-type-headline1 ...">제목</span>
//     headline1 = 제목 / body1 = 요약 스니펫
// ★네이버가 디자인 시스템(sds)을 갈아엎으면 여기부터 깨진다.
const SDS_TEXT_CLASS = 'sds-comps-text-type-';

// HTML 엔티티·태그를 걷어낸 순수 텍스트.
function decodeText(s) {
  return String(s || '').replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** 검색결과 HTML에서 특정 타입(headline1/body1 등) 텍스트를 순서대로 뽑는다. */
function grabSds(html, type, max = 10) {
  const re = new RegExp('<span[^>]*' + SDS_TEXT_CLASS + type + '[^>]*>([\\s\\S]*?)</span>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    const t = decodeText(m[1]);
    if (t) out.push(t);
  }
  return out;
}

/**
 * 검색결과에서 "제목 — 요약" 쌍을 만든다.
 * 제목만 주면 모델이 살을 지어내므로(가짜 발언·틀린 별명), 요약 스니펫을 붙여 날조를 막는다.
 * @returns {string[]} 최대 max개, 중복 제목 제거됨
 */
function grabTitleSnippetPairs(html, { max = 8, snippetLen = 180, minSnippet = 20 } = {}) {
  const heads = grabSds(html, 'headline1', max);
  const bodies = grabSds(html, 'body1', max);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (!h || seen.has(h)) continue;
    seen.add(h);
    const b = bodies[i];
    out.push(b && b.length > minSnippet ? `${h} — ${b.slice(0, snippetLen)}` : h);
  }
  return out.slice(0, max);
}

// 네이버 기사 링크(스포츠·연예·일반)에서 oid/aid + 종류를 뽑는 정규식.
// 예) https://n.news.naver.com/mnews/article/001/0012345678
//     https://m.sports.naver.com/wfootball/article/477/0000123456
// ★주소 체계가 바뀌면 기사 본문·기사 이미지 수집이 동시에 죽는다.
const ARTICLE_LINK_RE = /https?:\/\/(?:m\.)?(sports|entertain|n)\.(?:news\.)?naver\.com\/[a-z]*\/?(?:mnews\/)?article\/(\d{2,4})\/(\d{6,})/gi;

/** 검색결과 HTML → [{oid, aid, kind}] (중복 제거). kind = sports|entertain|news */
function grabArticleRefs(html, max = 8) {
  const re = new RegExp(ARTICLE_LINK_RE.source, 'gi'); // lastIndex 공유 방지 — 반드시 새 객체로
  const seen = new Set();
  const items = [];
  let m;
  while ((m = re.exec(html)) && items.length < max) {
    const kind = m[1] === 'sports' ? 'sports' : m[1] === 'entertain' ? 'entertain' : 'news';
    const key = m[2] + '/' + m[3];
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ oid: m[2], aid: m[3], kind });
  }
  return items;
}

// 기사 본문 영역(일반뉴스 모바일). 스포츠·연예는 api-gw JSON을 쓰므로 정규식 불필요.
const ARTICLE_BODY_RE = /<article[^>]*id=["']dic_area["'][^>]*>([\s\S]*?)<\/article>/i;
const ARTICLE_TITLE_RE = /<h2[^>]*id=["']title_area["'][^>]*>([\s\S]*?)<\/h2>/i;

// 검색 URL 빌더 — 쿼리 파라미터가 바뀌면 여기만 고친다.
const searchUrl = {
  news: (q) => 'https://search.naver.com/search.naver?where=news&sort=1&query=' + encodeURIComponent(q),
  blog: (q) => 'https://search.naver.com/search.naver?where=blog&query=' + encodeURIComponent(q),
};

// ─────────────────────────────────────────────────────────────
// B. 페이지 실행 스크립트 (Electron 숨은 창 executeJavaScript)
// ─────────────────────────────────────────────────────────────

// 정부·공식 사이트에서 본문 이미지 후보를 크기순으로. (로고·아이콘·배너는 이름으로 제외)
const OFFICIAL_IMG_EXTRACT = "(function(){function abs(u){try{return new URL(u,location.href).href;}catch(e){return u;}}var out=[],seen={};[].slice.call(document.querySelectorAll('img')).forEach(function(i){var s=i.currentSrc||i.src||i.getAttribute('data-src')||'';if(!s||/^data:/.test(s))return;var w=i.naturalWidth||i.width||0,h=i.naturalHeight||i.height||0;if(w&&h&&(w<220||h<160))return;if(/logo|icon|sprite|banner|btn[_-]|button|favicon|profile|thumb_s|blank|spacer|footer|header_/i.test(s))return;var u=abs(s);if(seen[u])return;seen[u]=1;out.push({url:u,w:w,h:h});});out.sort(function(a,b){return (b.w*b.h)-(a.w*a.h);});return JSON.stringify(out.slice(0,8));})()";

// Pexels(무료 스톡) 검색결과에서 원본 이미지 URL. ★images.pexels.com 주소 패턴 의존.
const PEXELS_EXTRACT = "(function(){var seen={},out=[];[].slice.call(document.querySelectorAll('img')).forEach(function(i){var s=i.src||i.getAttribute('data-src')||i.getAttribute('srcset')||'';var m=s.match(/https:\\/\\/images\\.pexels\\.com\\/photos\\/\\d+\\/[^\"'?\\s]+\\.(?:jpe?g|png)/i);if(!m)return;var u=m[0];if(seen[u])return;seen[u]=1;out.push(u+'?auto=compress&cs=tinysrgb&w=1200');});return JSON.stringify(out.slice(0,20));})()";

// 네이버 이미지검색 결과 → 원본 URL(프록시 주소에서 src= 파라미터를 풀어냄). ★search.pstatic.net 패턴 의존.
const NAVER_IMG_EXTRACT = "(function(){function dec(u){try{var m=u.match(/[?&]src=([^&]+)/);return m?decodeURIComponent(m[1]):u;}catch(e){return u;}}var seen={},out=[];[].slice.call(document.querySelectorAll('img')).forEach(function(i){var s=i.src||i.getAttribute('data-src')||'';if(!/search\\.pstatic\\.net\\/common/.test(s))return;var u=dec(s);if(seen[u])return;seen[u]=1;var host=(u.match(/^https?:\\/\\/([^\\/]+)/)||[''])[1]||'';out.push({url:u,host:host,proxy:s});});return JSON.stringify(out.slice(0,30));})()";

// 연예·스포츠 인기 랭킹(모바일). ★클래스명이 NewsList_news_list__* / NewsRanking_news_list__* 형태라 부분일치로 잡는다.
const ENT_URL = 'https://m.entertain.naver.com/ranking';
const SPT_URL = 'https://m.sports.naver.com/ranking/index?type=popular';
const ENT_EXTRACT = "(function(){var out=[],seen={};document.querySelectorAll('[class*=\"NewsList_news_list\"] li').forEach(function(li){var t=(li.textContent||'').replace(/\\s+/g,' ').trim().replace(/^\\d+위\\s*/,'').trim();if(t&&t.length>5&&!seen[t]){seen[t]=1;out.push(t.slice(0,70));}});return JSON.stringify({items:out.slice(0,12)});})()";
const SPT_EXTRACT = "(function(){var out=[],seen={};document.querySelectorAll('[class*=\"NewsRanking_news_list\"] li').forEach(function(li){var t=(li.textContent||'').replace(/\\s+/g,' ').trim().replace(/^\\d+\\.?\\s*/,'').trim();if(t&&t.length>5&&!seen[t]){seen[t]=1;out.push(t.slice(0,70));}});return JSON.stringify({items:out.slice(0,12)});})()";

// ★구조 파악용 덤프 — 셀렉터가 깨졌을 때 "지금 이 페이지에 어떤 리스트가 있는지" 후보를 뽑아본다.
//   깨진 페이지에 이걸 실행해 새 클래스명을 찾은 뒤 위 상수를 고친다.
const DISCOVER_DUMP = "(function(){var out=[];document.querySelectorAll('ol,ul').forEach(function(l){var lis=l.querySelectorAll('li');if(lis.length>=5&&lis.length<=30){out.push({cls:(l.className||'').toString().slice(0,60),count:lis.length,sample:[].slice.call(lis).slice(0,3).map(function(li){return (li.textContent||'').replace(/\\s+/g,' ').trim().slice(0,45);})});}});return JSON.stringify(out.slice(0,10),null,1);})()";

module.exports = {
  // A
  SDS_TEXT_CLASS, decodeText, grabSds, grabTitleSnippetPairs,
  ARTICLE_LINK_RE, grabArticleRefs, ARTICLE_BODY_RE, ARTICLE_TITLE_RE, searchUrl,
  // B
  OFFICIAL_IMG_EXTRACT, PEXELS_EXTRACT, NAVER_IMG_EXTRACT,
  ENT_URL, SPT_URL, ENT_EXTRACT, SPT_EXTRACT, DISCOVER_DUMP,
};
