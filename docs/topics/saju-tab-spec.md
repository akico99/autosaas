# 주제 탭 1: 사주보는 수달 — 결정 명세

결정: claude-opus-5-5 (2026-10-06 KST). 구현: gpt-6-luna(max) 작업자.
선행: docs/STATUS.md, docs/EVIDENCE_DECISIONS.md, docs/search/*.

## 0. 목표와 원칙

- 앱 위에 "주제 탭"을 둔다. 첫 주제는 사주보는 수달(https://sajuotter.com), 두 번째는 무주스키샵(https://www.mujusky.co.kr, 이번에는 비활성 자리만).
- 목적은 sajuotter.com 유입과 결제 전환이다. 원고는 정보 전달 중심이고 홍보는 본문 흐름 속 자연스러운 안내로 한다.
- 글쓴이는 서비스 운영자 본인이다. 운영자임을 첫 서비스 언급 지점에서 한 문장으로 밝힌다(예: "제가 운영하는 사주보는 수달에서는…"). 운영자가 고객인 척 쓰는 이용 후기, 가짜 고객 사례·만족도·별점은 금지.
- 기존 홈판용·검색용 탭은 "구버전" 그룹으로 옮기고 동작은 그대로 둔다.
- 실제 Claude 호출, 네이버 로그인·발행, Electron 실행, git commit은 구현 작업자가 하지 않는다(리드가 검증·커밋). 네트워크 요청이 필요한 기능은 주입 가능한 함수로 만들고 테스트는 가짜 구현으로 한다.
- 사용자의 다른 변경을 되돌리지 않는다. 최소 수정.

## 1. 화면 구조 (app/app.html)

- 상단 탭 줄: [사주보는 수달] [무주스키샵 (준비 중, 비활성)] [구버전 ▾].
- 구버전을 누르면 기존 [홈판용][검색용] 탭이 보이고 기존 패널이 그대로 동작한다. 기존 data-tab="home"/"search" 패널, 예약, 성과 패널 코드는 수정하지 않고 감싸기만 한다.
- 앱 시작 기본 탭: 사주보는 수달. 예약 자동 실행(auto=1)은 기존 kind 그대로 구버전 패널을 쓴다.
- 사주 탭 패널 구성(위→아래):
  1. 블로그 프로필 선택 + [프로필 관리]
  2. 키워드: 우선순위 목록(칩 10개, 각 칩에 연결 상품·블로그 진입 가능성 배지) + 직접 입력칸
  3. 용도: [검색용] [홈판용]
  4. 연결 상품: 키워드에서 자동 선택, 드롭다운으로 변경 가능
  5. 사진: 캡처 묶음 상태(캡처 날짜·장수) + [사이트 캡처 갱신] + [사진 직접 추가]
  6. [글 만들기] + 상태줄(기존 renderGenWarnings 재사용)
  7. 📈 성과 추적 패널(이 탭 전용 목록, 2단계에서 통합검색 기준으로 교체)

## 2. 주제 설정 — 새 파일 src/topics/saju.js

정적 설정 객체를 export. 코드와 분리해 주제 추가가 설정만으로 가능하게 한다(src/topics/index.js에서 { saju } 목록 export, mujusky는 enabled:false 자리만).

- id 'saju', label '사주보는 수달', siteUrl 'https://sajuotter.com', domains ['sajuotter.com'].
- serviceFacts(원고에 쓸 수 있는 사실만, 2026-10-05 사이트 확인):
  - 상담사 없이 AI가 만세력 계산부터 풀이 리포트까지 만든다. 결제 후 최대 10분 안에 PDF로 받는다.
  - 무료: 오늘의 운세, 인생 그래프, 사주 도감, 내 오행 밸런스, 사주 속 귀인, 타고난 매력, 2026년 신년운세.
  - 유료: 주제별 심층 리딩 3,900원(내 사주 첫 풀이, 재물운, 직업·적성운(5년 이직 타임라인), 애정·결혼운, 대인관계·인복, 건강운), 궁합 4,900원(재회 관점 포함), 날짜 리포트 3,900원(이사·개업·결혼·임신출산), 평생사주 100페이지 14,900원.
  - 콘텐츠는 명리학적 경향에 근거한 참고 자료이며 의학·법·재정 조언을 대체하지 않는다.
- products: [{key, label, price, url(절대 URL), tags[], fitsIntents[]}] — 위 상품 각각. URL은 사이트의 실제 경로(/compat.html, /quick.html?topic=intro|wealth|career|love|relationship|health, /date-select.html?occasion=moving|opening|wedding|birth, /lifetime-report.html, /today-fortune.html, /free.html?kind=balance|noble|charm, /life-graph.html, /field-guide.html, /services.html).
- ctaUrl(product, ctx): product.url에 utm_source=naver_blog&utm_medium=organic&utm_campaign=<blogKey>&utm_content=<encodeURIComponent(keyword)> 추가.
- writingRules(프롬프트로 주입):
  - 단정·공포 금지("이 사주는 이혼한다", "큰일 난다"). "경향", "참고" 표현.
  - 건강·법률·투자 결정을 사주로 권하지 않는다.
  - 가격·기능은 serviceFacts에 있는 것만. 없는 할인·이벤트·적중률·이용자 수 금지.
  - 서비스 언급은 본문 흐름상 그 서비스가 독자의 질문에 실제로 답하는 지점에서 최대 2회(중간 1회 + 마무리 1회). 첫 언급에 운영자 표시 문장.
  - 무료 진입 서비스를 먼저 안내하고, 유료는 "더 깊게 보려면"으로 연결.
  - 경쟁 서비스 비방 금지. 비교가 필요하면 기준(상담사 여부, 결과 형태, 가격대)으로 일반화.
- keywordPlan: 우선순위 10개(아래 표). 각 항목 { keyword, monthly, product, intentHint, blogSlot:'high'|'mid'|'low', serpNote, observedAt:'2026-10-05' }.

| 순위 | 키워드 | 월검색 | 상품 key | blogSlot | serpNote |
|---|---|---|---|---|---|
| 1 | 인터넷사주 | 38380 | intro | high | 문서 영역 블로그 비중 높음(15/25), 이용 후기형 글 다수, 플레이스·상담 영역 있음 |
| 2 | 재회사주 | 2790 | compat | high | 블로그 비중 높음(13/25), 재회 시기·구조 설명형 글 |
| 3 | 사주궁합 | 8430 | compat | mid | 블로그·카페·지식iN 혼합, 상담 영역 있음 |
| 4 | 무료사주궁합 | 5700 | compat | mid | AI 브리핑 있음, 웹사이트 비중 높음 |
| 5 | AI사주 | 5760 | intro | mid | 첫 문서가 경쟁 서비스 사이트, 영상 많음 |
| 6 | 사주사이트 | 10010 | services | mid | 첫 문서가 경쟁 사이트, 카페 비중 있음 |
| 7 | 무료사주 | 30880 | free-balance | low | 웹사이트·지식iN 비중 높음 |
| 8 | 사주풀이 | 10550 | intro | low | 첫 문서가 만세력 사이트 |
| 9 | 사주보기 | 5440 | intro | low | AI 브리핑, 만세력 사이트 |
| 10 | 연애사주 | 3130 | love | low | 첫 문서가 경쟁 사이트, 쇼핑 영역 |

## 3. 블로그 프로필 (여러 블로그 운영)

- 저장: userData/topic-profiles.json { profiles:[{key, topicId, name, blogId, persona, focus, toneHint, frameColor, createdAt}] }. 원자적 쓰기.
- 기본 프로필 템플릿 3개를 처음 실행 시 생성(blogId 비움, 사용자가 수정):
  - 'saju-a' "명리 공부 기록": 사주를 공부하며 서비스를 만든 운영자, 개념을 쉽게 풀어 설명, focus 기초 명리·사주풀이.
  - 'saju-b' "관계 고민 상담": 연애·궁합·재회 질문을 정리하는 운영자, 다정한 설명체, focus 궁합·연애·재회.
  - 'saju-c' "일과 돈 흐름": 직업·재물·시기 질문을 정리하는 운영자, 똑부러진 정리체, focus 직업·재물·택일.
- 프로필 관리 UI: 목록·추가·수정·삭제(삭제는 confirm). 모든 문자열 esc().
- 키워드-블로그 충돌 방지: userData/topic-keyword-log.json에 {topicId, blogKey, keyword(정규화), at}. 같은 키워드를 다른 블로그에서 30일 안에 쓰려 하면 수동 생성은 경고 후 confirm, 자동 경로는 건너뜀. 같은 블로그 재사용은 14일 경고.

## 4. 생성 연결

- 새 모듈 src/topics/topicContext.js: buildTopicContext({ topic, profile, keyword, productKey, purpose, assets }) → { promptBlock(문자열), product, ctaUrl, disclosureLine, assetCatalog, evidenceSource }.
  - promptBlock: [주제 탭: 사주보는 수달] 섹션 — 글쓴이(프로필 persona·toneHint·focus), 서비스 사실(serviceFacts 전문), 연결 상품(라벨·가격·URL), writingRules, 운영자 표시 문장 지시, CTA 위치 지시, 사진 목록(5장 참조).
  - evidenceSource: serviceFacts를 sourceType 'user-provided'·contentKind 'service-facts'·url siteUrl 로 구조화. 검색용 근거 판정에서 사용자 제공 원문으로 인정되게 기존 근거 정책 입력 형식에 맞춘다(서비스 찾기·방법 의도가 근거 부족으로 보류되지 않게). 최신 이슈 의도에는 원문으로 인정하지 않는다.
- 검색용: generateSearchPost에 topicContext 인자 추가. 있으면 buildSearchUserPrompt 끝(재생성 블록 전)에 promptBlock 삽입, 근거 목록에 evidenceSource 추가. 없으면 기존 동작 100% 동일.
- 홈판용: postTypes에 'saju' 유형 추가(label '사주·운세형', hidden:true — 구버전 홈판 유형 목록에 노출하지 않음). 홈판 자극어 규칙은 유지하되 공포·단정 훅 금지 문장을 유형 설명에 넣는다. generatePost에 topicContext 인자 추가, buildUserPrompt 끝에 promptBlock 삽입. 없으면 기존 동작 동일.
- CTA: 원고 마지막에 링크 블록 1개(ctaUrl). 앱 편집기 주입이 이미 지원하는 링크/OG 카드 형식을 사용(작업자가 finishGen/주입 코드에서 지원 형식을 확인해 맞춘다). 본문 중간 언급은 텍스트만.
- 검증 추가(사주 탭에서만, generateSearchPost/generatePost 반환 후 renderer가 아닌 main 쪽 공통 함수 checkTopicPost(post, ctx)): ①운영자 표시 문장 존재 ②서비스명 언급 2회 이하(제목 제외) ③serviceFacts에 없는 가격(숫자+원) 금지 ④"후기|직접 결제해|써봤" 류 고객 시점 표현 금지 ⑤금지 표현(적중률, 100%, 무조건, 큰일). 위반은 status를 review로 올리고 reviewReasons에 추가, ④⑤는 hold.
- generate:topic IPC 새로 추가(기존 generate:search/post 핸들러는 그대로): { topicId, profileKey, keyword, purpose:'search'|'home', productKey, opts } → 내부에서 topicContext 구성 후 해당 생성 함수 호출, 결과에 topic 메타(profileKey, productKey, ctaUrl) 포함, 키워드 로그 기록, 성과 추적 엔트리 생성(blogKey·productKey 포함).

## 5. 사진: 사이트 캡처 묶음

- 새 모듈 electron/siteCapture.js(메인 프로세스): captureTopicSite(topic, { outDir, partition:'persist:topic-capture' }).
  - 별도 파티션(로그인 없음). 모바일 뷰포트 412x915, deviceScaleFactor 2, 모바일 UA.
  - 페이지 목록은 topic.capturePages: home(/), services, compat, quick intro/love/wealth/career, lifetime-report, webtoon/lifetime.html, today-fortune, free balance, life-graph, date-select wedding. 각 { id, path, caption, tags }. mypage·profiles·pay·login 경로는 코드에서 거부.
  - 각 페이지: load 후 2.5초 대기 → 첫 화면 캡처, 이어서 화면 높이의 90%씩 스크롤하며 최대 3장. 이전 조각과 픽셀 해시가 같으면 버린다. 차단·오류 페이지(404, 빈 화면)는 건너뛰고 결과에 기록.
  - 결과: outDir = userData/topic-assets/saju/capture-YYYYMMDD/, manifest.json { capturedAt, items:[{ id:'compat-1', pageId, url, slice, path, caption, tags, sha1 }] }. 이전 캡처 폴더는 지우지 않고 그대로 두며, 목록에는 가장 최근 캡처만 사용한다.
- 직접 추가: [사진 직접 추가]로 고른 파일을 userData/topic-assets/saju/custom/에 복사, caption·tags 입력(리포트 샘플 PDF 화면, 수달 일러스트 등). manifest-custom.json.
- IPC: topicAssets:list(topicId) → 최신 캡처 + custom 합친 목록, topicAssets:capture(topicId), topicAssets:addCustom({topicId, files, caption, tags}).
- 원고에 넣는 방식:
  - assetCatalog: 상품·키워드 태그가 맞는 순서로 최대 24개 { id, caption, tags }를 프롬프트에 제공. 모델은 image 블록에 { kind:'image', assetId:'compat-1', imageHint } 로 지정. searchQuery 쓰지 않음.
  - 사주 탭 생성 결과를 finishGen으로 넘길 때 기존 "내 사진" 경로를 재사용: assetId → 파일 경로로 바꿔 window._myPhotos 순서로 넣고 mine 모드를 켜고 웹 자동 사진은 끈다. 잘못된/없는 assetId는 태그 일치 순으로 대체, 같은 글에서 같은 자산 반복 금지.
  - 장수: 검색용 3~6장, 홈판용 3~5장. 강제로 채우지 않는다(자산이 부족하면 적게).
  - 블로그별 변형: 넣기 직전에 프로필 frameColor로 여백 24px·둥근 모서리 테두리를 입힌 사본을 userData/topic-assets/saju/framed/<blogKey>/에 만들어 쓴다(기존 renderHtmlToPngWin 활용, 같은 원본·블로그 조합은 캐시).
  - 사용 기록: topic-asset-usage.json {assetId, blogKey, at}. 다른 블로그에서 14일 안에 쓴 자산은 후순위.
- 대표 이미지(썸네일): 기존 썸네일 생성기 bgImage에 home 또는 상품 페이지 캡처를 깔고 thumbnailText를 얹는다. 기존 썸네일 설정 UI 값(글꼴·색)은 사주 탭 전용 저장 키로 분리.
- 캡처가 하나도 없으면 생성 전에 상태줄로 [사이트 캡처 갱신]을 안내하고, 사진 없이 생성할지 confirm.

## 6. 2단계: 통합검색 추적 (naver-serp-monitor 파서 이식)

1단계 완료·검증 후 진행한다.

- 새 모듈 src/keyword/integratedSerp.js: naver-serp-monitor/collector/parser.py의 블록 분류 규칙을 JS로 이식.
  - 루트 #main_pack(없으면 place-app-root 부모, 그다음 body). 직계 자식 중 script/style/link·검색옵션·페이지 이동·브라우저 안내·텍스트 없는 것 제외.
  - 분류: place-app-root → 플레이스(주소+전화번호 라벨이면 업체 상세), class 없는 section → 검색광고, spw_fsolid → 관련문서, _fe_view_root → 브랜드 콘텐츠, 그 외 h2/h3 제목, 없으면 기타(순서 미소비).
  - 항목 추출: 블록 안 a[href] 중 텍스트 8자 이상, ader.naver.com·help·keep 제외, 제목 중복 제거. { title, url, domain, sourceType(블로그/카페/지식iN/영상/웹/네이버기타) }.
  - 대상 판정: domains(sajuotter.com)과 일치 → site hit; blog.naver.com/<blogId>/<logNo>가 추적 글과 일치 → post hit. 결과 { blockOrder, blockName, blockKind, positionInBlock, overallDocPosition }.
- 수집: 렌더링이 필요하므로 기존 runGuardedSearch + scrapeRendered('persist:naver-search')로 통합검색 HTML(document.documentElement.outerHTML)을 받는다. 키워드당 캐시 공유, 최소 간격·차단 유예 그대로.
- 성과 추적 교체(사주 탭 및 기존 패널 공통): 블로그 탭 순위 조회 제거. 체크마다 integratedSerp 결과로 { found:boolean, blockName, blockOrder, positionInBlock, siteFound:{blockName, positionInBlock}|null } 저장. 요약: 의도·상품·블로그별 "통합검색 노출률(앞 5개 블록 안)", 블록별 분포, 사이트 자체 노출 여부.
- 주제 분석: [주제 분석 갱신] 버튼 — keywordPlan 10개를 순서대로 관찰(요청 간격 20±5초, 차단 시 즉시 중단)해 keywordPlan의 blogSlot·serpNote를 관찰값으로 갱신 저장(topic-serp-YYYYMMDD.json). 자동 실행 없음.
- 테스트: 합성 HTML 픽스처(광고 section, place-app-root, spw_fsolid, _fe_view_root, h2 블록, sajuotter 링크, 블로그 링크)로 분류·순서·적중 판정 검증.

## 7. 테스트와 완료 조건

- 1단계 테스트(scripts/tests/topic-saju.test.js): 주제 설정 무결성(상품 URL이 sajuotter.com, 가격 형식), ctaUrl UTM, buildTopicContext 출력에 운영자 표시·금지 규칙·사진 목록 포함, checkTopicPost 각 위반 판정, 키워드-블로그 충돌 규칙(30일/14일), assetId 매핑·대체·중복 방지, 프로필 저장 원자성, 캡처 경로 거부 목록(mypage/pay), generateSearchPost·generatePost가 topicContext 없을 때 기존 프롬프트와 동일(스냅샷 비교).
- 2단계 테스트(scripts/tests/integrated-serp.test.js).
- npm test 전체 통과, npm run check 통과.
- 문서: docs/STATUS.md에 주제 탭 진행 상황 추가, README 구조에 src/topics 추가.
