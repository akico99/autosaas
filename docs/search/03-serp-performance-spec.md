# 검색 결과 관찰 + 성과 추적 — 결정 명세 v2

결정: claude-opus-5-5 (2026-10-04). 구현: gpt-6-luna(max) 작업자. 선행 명세: docs/search/02-search-standard-spec.md (이미 구현됨).

## 0. 배경과 원칙

- 2026-10-04 23:35 KST 기준, 이 PC의 Node https 요청으로 search.naver.com을 호출하면 **HTTP 403 + "검색 서비스 이용이 제한되었습니다 … 프로그램 등을 이용, 특정 단어를 반복적으로 대량으로 입력"** 페이지가 온다. npm run doctor에서 뉴스·블로그 기반 수집 5종이 전부 0건이고, 현재 앱은 이를 "마크업 변경"으로 잘못 안내한다.
- 따라서 이번 작업의 1순위는 **네이버 검색 요청 보호 장치**다. 검색 결과 관찰과 순위 확인은 그 위에서만 요청한다. 요청 수를 늘리는 설계는 금지한다.
- **구현·테스트 중 search.naver.com 등 네이버로 실제 요청을 보내지 않는다.** (제한 해제 전까지 추가 요청은 제한을 연장시킬 수 있다.) 파서는 아래 6장의 합성 HTML 픽스처로 검증한다. Claude 호출, Electron 실행, git commit도 하지 않는다.
- 사용자의 커밋 안 된 변경과 이전 작업 변경을 되돌리지 않는다. 필요한 부분만 수정한다.
- 로그인 세션(persist:naver)이나 쿠키를 검색 요청에 쓰지 않는다. 계정이 자동 요청과 묶이지 않게 한다.
- 화면 문구는 순위를 "비로그인·PC 환경에서 관찰한 값"으로 표기하고 개인화로 실제와 다를 수 있다고 한 줄 안내한다.

## 1. 검색 요청 보호 장치 — 새 파일 src/scrape/naverSearchGuard.js

내보내기: guardedSearchFetch(url, opts), isSearchBlocked(), getBlockState(), NaverSearchBlockedError, isBlockPage(status, body), _setTransportForTest(fn), _setClockForTest(fn), _resetForTest().

- 대상: URL 호스트가 search.naver.com 인 요청만. 다른 호스트는 이 모듈을 거치지 않는다.
- transport 기본값: 현재 trends.js의 fetchBuffer와 같은 Node https GET(헤더 동일, 12초 타임아웃). 반환 { status, body(Buffer) }. 테스트는 _setTransportForTest로 대체.
- 캐시: URL 단위 메모리 캐시 30분. 성공 응답(200)만 저장.
- 간격: 모든 검색 요청을 직렬 큐로 처리하고, 직전 요청 완료 후 최소 1500ms + 0~1000ms 무작위 대기.
- 차단 감지 isBlockPage: status===403 이거나 본문(utf8)에 '검색 서비스 이용이 제한되었습니다' 포함.
- 차단 시: blockedUntil = now + 30분, blockedAt 기록, NaverSearchBlockedError 던짐. blockedUntil 전에는 **네트워크 요청 없이** 즉시 같은 오류를 던진다. 캐시 적중은 차단 중에도 반환해도 된다.
- 한 번의 앱 실행(프로세스) 동안 차단을 연속 2회 이상 만나면 blockedUntil을 2시간으로 늘린다.
- getBlockState(): { blocked:boolean, blockedAt, blockedUntil, message }. message = '네이버 검색이 이 네트워크에서 일시 제한됐어요. 브라우저로 네이버 검색에 접속해 [제한 해제] 보안 절차를 직접 진행한 뒤 다시 시도하세요.'

### trends.js 연결

- M.searchUrl.news/blog 및 '가볼만한곳' 통합검색을 부르는 모든 fetchBuffer 호출을 guardedSearchFetch로 바꾼다(fetchNewsHeadlines, fetchPlaceReviews, fetchNearbyAttractions, fetchBlogFacts, fetchArticleImages, fetchNewsArticles, fetchTopTitles). 기사 본문(n.news.naver.com 등)과 다른 사이트 요청은 그대로 둔다.
- NaverSearchBlockedError가 나면 해당 함수는 기존처럼 [] 를 반환하되 health.record(source, 0, { query, blocked:true }) 로 기록한다.

### health.js

- record의 meta.blocked를 state에 저장(blocked:true).
- report(): 차단된 소스가 하나라도 있으면 { ok:false, blocked:true, broken:[...], message: getBlockState().message 와 같은 취지 } 를 반환하고, 마크업 변경 문구는 쓰지 않는다. 차단이 아닌 0건만 있을 때 기존 문구 유지.
- SOURCES에 'serp': { label:'통합검색 결과 관찰', fix:'markup.js parseSerpSections / searchUrl.integrated' } 추가.

### doctor.js

- 각 체크 전에 isSearchBlocked()면 네트워크 요청 없이 해당 행 상태를 BLOCKED로 표시.
- 체크 결과가 0건이고 health 상태가 blocked면 FAIL 대신 BLOCKED.
- 마지막 안내: BLOCKED가 하나라도 있으면 getBlockState().message를 출력하고 "구조 변경" 안내는 출력하지 않는다. 종료 코드는 BLOCKED만 있을 때 2, FAIL 있을 때 1.
- doctor에 'serp' 체크 추가(observeSerp(KW_TOPIC), min 3 sections).

## 2. 생성 흐름과 차단

- generateSearchPost: brief 생성 직전에 isSearchBlocked() 결과를 brief 입력으로 넘긴다(searchBlocked).
- searchBrief.buildSearchBrief({..., searchBlocked, serp}):
  - searchBlocked===true → evidence.searchBlocked=true, preHoldReasons에 '네이버 검색 제한으로 근거 자료를 가져오지 못함' 추가. (자동 실행은 strictEvidence로 생성 자체를 건너뛰고, 수동 생성은 보류 상태로 표시된다 — 기존 computeSearchStatus 규칙 그대로.)
- app.html autoRun: hold 사유에 '네이버 검색 제한'이 포함되면 finishAuto 메시지를 '네이버 검색 제한 — 이번 예약 실행 중단'으로 하고, 같은 실행에서 다음 글 생성을 시도하지 않는다(현재 1회 실행 1글 구조면 기존 종료로 충분. 반복 루프가 있다면 루프 탈출).
- renderGenWarnings: res.scrapeHealth.blocked면 '🚫 네이버 검색 제한' 문구와 message를 기존 수집 문제 자리에 표시.

## 3. 검색 결과 관찰 — 새 파일 src/keyword/serpObserve.js

- markup.js에 추가: searchUrl.integrated = (q) => 'https://search.naver.com/search.naver?where=nexearch&query=' + encodeURIComponent(q)
- markup.js에 추가: parseSerpSections(html) → { sections:[문자열], blogRefs:[{blogId,logNo,url}], placeLinks:boolean, kinLinks:boolean }
  - sections: <h2 ...>...</h2> 내부 텍스트를 decodeText로 정리, 빈 값·중복 제거, 등장 순서 유지, 최대 20개. 끝의 ' 검색 결과' 문구만 있는 h2(예: '사주 궁합 검색 결과')는 제외.
  - blogRefs: /https?:\/\/(?:m\.)?blog\.naver\.com\/([A-Za-z0-9_-]+)\/(\d{9,})/g 등장 순서, (blogId,logNo) 중복 제거, 최대 30개, url은 'https://blog.naver.com/'+id+'/'+logNo.
  - placeLinks: (pcmap\.)?place\.naver\.com|map\.naver\.com 존재. kinLinks: kin\.naver\.com/qna 존재.
- markup.js에 섹션 분류표 SERP_SECTION_RULES(순서대로 첫 일치):
  - aiBriefing: /AI\s*브리핑/
  - dictionary: /국어사전|어학사전|영어사전|지식백과|백과사전/
  - ads: /관련 광고|파워링크/
  - brandContent: /브랜드 콘텐츠/
  - shopping: /가격비교|플러스 스토어|쇼핑/
  - expertService: /상담|엑스퍼트/
  - news: /뉴스/
  - kin: /지식iN/
  - popularPosts: /인기글/
  - image: /^이미지$/
  - video: /동영상|클립/
- observeSerp(keyword, { fetch = guardedSearchFetch } = {}):
  - 한 번만 요청(캐시 공유). 성공 → { measured:true, observedAt(ISO), query, sections, flags:{aiBriefing,dictionary,ads,brandContent,shopping,expertService,news,kin,popularPosts,place}, firstSections:[앞 3개 섹션의 분류키], blogRefs, topDocs: M.grabTitleSnippetPairs(html,{max:6,snippetLen:120}) }. flags.place = placeLinks 또는 섹션명에 /플레이스|지도/.
  - 차단 → { measured:false, blocked:true, reason:'blocked' }. 기타 오류 → { measured:false, blocked:false, reason }.
  - health.record('serp', sections.length 또는 0, { query, blocked }).
- 결과는 키워드 기준 프로세스 메모리 캐시 6시간(같은 키워드 재생성·순위 확인 재사용).

### generateSearchPost 연결

- 자동완성 수집 직후, kw가 있고 review/source가 없을 때 observeSerp(kw) 1회 호출(실패해도 진행). 결과를 buildSearchBrief({..., serp})로 전달.

### searchBrief 보정 calibrateIntentWithSerp(classified, serp) — buildSearchBrief 안에서 호출

- serp.measured가 아니면 그대로 두고 brief.serp={measured:false, blocked, reason}, reviewReasons로 쓰일 warnings에 '검색 결과 관찰 실패 — 의도 보정 없이 작성' 추가.
- classified.ambiguous===true 일 때만 의도를 바꾼다. 순서대로 첫 일치:
  1. firstSections에 dictionary → definition
  2. flags.place → place
  3. firstSections에 news → news
  4. flags.expertService → service
  5. flags.shopping → compare
  - 바뀌면 ambiguous=false, reason='검색 결과 보정: <근거 섹션명>'. 안 바뀌면 ambiguous 유지.
- 의도와 무관하게 serpNotes 생성(문장 그대로):
  - aiBriefing: '검색 결과에 AI 브리핑이 있어 단순 요약만으로는 클릭할 이유가 약함 — 조건별 설명·예시·비교처럼 요약에 없는 내용을 더하세요'
  - dictionary: '사전 결과가 상단에 있음 — 뜻 풀이는 짧게, 쓰임·예시·헷갈리는 점에 비중을 두세요'
  - ads 또는 brandContent: '광고·브랜드 콘텐츠가 경쟁하는 상업 키워드 — 판매 문구와 구분되는 객관적 정보가 필요해요'
  - expertService: '유료 상담 서비스가 노출되는 키워드 — 서비스 홍보처럼 보이지 않게 쓰세요'
- brief.serp = { measured, observedAt, sections(앞 8개), flags, notes:serpNotes, topDocs }.
- 앞서 만든 intent 의존 값(requiredAnswers, minChars 등)은 보정 후 의도로 계산한다.

### 프롬프트(buildSearchUserPrompt)

brief.serp.measured일 때 [원고 기획] 블록 다음에 추가:

    [검색 결과 관찰 — {observedAt} 비로그인 PC 기준]
    - 결과 구성(위에서부터): 섹션1 / 섹션2 / …(최대 8)
    - 유의점: notes 각 줄
    - 상위 문서 제목·요약(참고용, 문장·구성 베끼기 금지. 이 문서들이 다루지 않는 조건·예시·비교를 더한다): topDocs 최대 6줄

## 4. 성과 추적

### 4.1 순수 로직 — 새 파일 src/performance/tracker.js (fs 직접 사용 금지, 데이터 객체를 받아 새 객체 반환)

- DUE_DAYS = [1, 3, 7, 14, 28]
- createEntry({ keyword, topic, intent, status, title, generatedAt, version }) → { id, keyword, topic, intent, statusAtGen, titleAtGen, generatedAt, version, url:null, blogId:null, logNo:null, publishedAt:null, linkedBy:null, checks:[] }. id = generatedAt 밀리초 + '-' + 키워드 해시 8자.
- normalizeTitle(t): 공백·문장부호·이모지 제거, 소문자.
- matchPublished(entries, posts) — posts: [{title, url, addDate?}]. url이 null인 entry를 대상으로, normalizeTitle 동일 → 연결. 동일이 없으면 짧은 쪽 길이/긴 쪽 길이 ≥ 0.85 이면서 한쪽이 다른 쪽을 포함 → 연결. 한 post는 한 entry에만. entry.generatedAt 이전에 발행된 post(addDate가 있을 때)는 제외. 연결 시 blogId/logNo를 url에서 파싱, publishedAt = addDate(밀리초·문자열 모두 처리) 없으면 연결 시각, linkedBy='auto'.
- linkManually(entry, url): blog.naver.com/{id}/{logNo} 또는 m.blog.naver.com/... 형식만 허용, 아니면 오류. linkedBy='manual', publishedAt 없으면 연결 시각.
- dueChecks(entries, now): publishedAt 있는 entry마다, 아직 기록 없는 dueDay 중 now ≥ publishedAt + dueDay일 인 것의 **가장 큰 하나만** 반환(밀린 날짜를 여러 번 채우지 않음). 반환 [{id, dueDay}], publishedAt 오래된 순.
- findRank(blogRefs, blogId, logNo) → 1부터 시작하는 순위 또는 null.
- addCheck(entry, { at, dueDay, blogTabRank, blogTabObserved, inIntegrated, measured, reason }) → 같은 dueDay가 이미 있으면 교체.
- summarize(entries) → { byIntent: {intent:{tracked, linked, checked, found, top10, medianBestRank}}, byStatus: {ready|review|hold: 같은 구조} }. bestRank = checks 중 measured이고 blogTabRank 있는 최솟값.

### 4.2 저장·IPC (electron/main.js)

- 파일: userData/search-performance.json { version:1, entries:[] }. 읽기 실패 시 빈 구조. 쓰기는 임시 파일에 쓰고 rename.
- generate:search 성공(post 있음) 시 createEntry 추가(최근 500개 유지). hold 여부와 무관하게 기록(상태별 비교용).
- 기존 blog:myPosts 본문을 fetchMyBlogPosts(blogId) 함수로 분리해 재사용(동작 동일). postList 항목에 addDate가 있으면 함께 반환.
- IPC 추가 + preload 노출:
  - perf:list → { ok, entries(최근 50, 최신순), summary, blockState, due: dueChecks 개수 }
  - perf:sync { blogId } → fetchMyBlogPosts 후 matchPublished, 저장, { ok, linked:n }
  - perf:link { id, url } → linkManually
  - perf:check → dueChecks 중 **최대 6개**만 순서대로 처리. 각 항목: 블로그 탭 1페이지(guardedSearchFetch(M.searchUrl.blog(keyword)) → parseSerpSections(html).blogRefs → findRank) + observeSerp(keyword)(캐시 재사용)의 blogRefs로 inIntegrated. 차단 오류가 나면 즉시 중단하고 남은 항목은 기록하지 않음. 결과 { ok, checked:n, stopped:'blocked'|null, blockState }.
  - 순위 확인은 이 버튼 경로에서만 실행한다. 앱 시작·예약 실행에서 자동 실행하지 않는다.

### 4.3 UI (app/app.html 검색용 탭, 예약 섹션 아래)

- 접히는 패널 '📈 검색 성과 추적'. 열 때 perf:list 호출.
- 상단: 블로그 ID 입력칸(localStorage 'perfBlogId', 비어 있으면 기존 방식처럼 에디터 URL에서 추출 시도), 버튼 [발행 글 연결] [순위 확인 (대상 N개)].
- 안내 한 줄: '순위는 비로그인·PC 환경에서 관찰한 블로그 탭 1페이지 기준이에요. 개인화로 실제와 다를 수 있어요. 순위 확인은 한 번에 최대 6개만 해요.'
- 차단 상태면 빨간 안내(blockState.message)를 보여주고 [순위 확인]을 비활성화.
- 표(최근 50): 키워드 | 의도 | 생성 상태 | 발행일 | 최근 블로그 탭 순위('30위 밖'/숫자/'-') | 확인 이력(예: 1일 12위 · 3일 8위). 미연결 행은 작은 주소 입력칸 + [연결].
- 요약 표: 의도별·생성 상태별 tracked / 연결 / 확인 / 10위 안 / 최고 순위 중앙값.
- esc()로 모든 사용자·외부 문자열을 이스케이프한다.

## 5. 이번 범위에서 제외

- 크리에이터 어드바이저 유입 검색어 수집(로그인·렌더 필요) — 다음 단계.
- 블로그 탭 2페이지 이상 조회.
- 홈판 경로, 이미지 파이프라인, competition.js.

## 6. 테스트 (scripts/tests/serp-performance.test.js, 오프라인)

픽스처는 테스트 파일 안에 합성 HTML 문자열로 둔다. 2026-10-04 Chrome에서 관찰한 실제 섹션명을 쓴다: '사주 궁합 검색 결과'(제외 대상), '사주궁합 관련 광고', '브랜드 콘텐츠', '이미지', '네이버 가격비교', '네이버플러스 스토어', '운세/타로/작명 상담' / '사주 뜻 검색 결과', '국어사전', 'AI 브리핑', '네이버 가격비교'. 블로그 링크 예: https://blog.naver.com/nomadyoon/224012345678.

1. isBlockPage: 403 → true, 200+제한 문구 → true, 200 정상 → false.
2. guardedSearchFetch: 가짜 transport가 차단 페이지 반환 → NaverSearchBlockedError, 이후 호출은 transport 호출 없이 즉시 오류(호출 횟수 검사), 가짜 시계로 31분 뒤 다시 요청. 같은 URL 두 번 → transport 1회(캐시). 연속 2회 차단 → 2시간.
3. parseSerpSections: 섹션 순서·'검색 결과' 제외·blogRefs 중복 제거·순서.
4. observeSerp(주입 fetch): '사주 뜻' 픽스처 → flags.dictionary, flags.aiBriefing, firstSections에 dictionary. 차단 → measured:false, blocked:true.
5. calibrate: '사주 궁합'(general ambiguous) + 궁합 픽스처 → service, reason에 '운세/타로/작명 상담'. 의도가 이미 정해진 '사주 보는 법'은 howto 유지. serp 미측정 → warnings에 관찰 실패.
6. buildSearchBrief(searchBlocked:true) → preHoldReasons에 '네이버 검색 제한'.
7. tracker: matchPublished(정확 일치·0.85 포함·generatedAt 이전 제외·중복 연결 방지), linkManually 형식 검증, dueChecks(밀린 날짜는 가장 큰 하나), findRank, summarize(top10·중앙값).
8. health.report: blocked 기록 → blocked:true, 메시지에 '구조' 단어 없음.
9. 프롬프트: brief.serp.measured 일 때 '[검색 결과 관찰' 포함, 미측정이면 미포함.

## 7. 완료 조건

- node --test scripts/tests/*.test.js 전부 통과, npm run check 통과.
- **npm run doctor는 실행하지 않는다**(실제 요청 발생). 대신 doctor.js 문법은 check로 확인.
- 변경 파일 요약, 명세와 다르게 한 점과 이유, 테스트 결과를 한국어로 보고. 커밋하지 않는다.
