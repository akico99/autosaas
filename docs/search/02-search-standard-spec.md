# 검색용 원고 기준 v1 — 앱 적용 결정 명세

결정: claude-opus-5-5 (2026-10-04). 구현: gpt-6-luna(max) 작업자.
근거 문서: docs/search/01-blog-writing-standard.md

## 0. 범위와 원칙

- 대상은 **검색용 생성 경로만**이다: src/generator/generateSearchPost.js, buildSearchPrompt.js, searchTopics.js, 새 모듈, electron/main.js의 generate:search 핸들러, electron/preload.js의 generateSearch, app/app.html의 검색용 생성·경고 표시·예약 자동 실행(kind=search) 부분.
- **홈판용(generatePost.js, buildPrompt.js, 홈판 UI/예약), 이미지 수집 파이프라인, 썸네일 렌더링, 키워드 도구(report.js), competition.js는 수정하지 않는다.** competition.js의 실패 시 기본값 문제는 현재 생성 경로에서 호출되지 않으므로 다음 단계로 미룬다.
- 작업 트리에 사용자의 커밋 안 된 변경(README.md, app/app.html, electron/main.js, electron/preload.js, package*.json, keyword-workflow/, scripts/keyword-report.js, scripts/tests/, src/keyword/report*.js)이 있다. **기존 변경을 되돌리거나 덮어쓰지 말고, 필요한 줄만 수정한다.** git commit, push, reset, checkout은 하지 않는다.
- 실제 Claude 호출(runClaude), 네이버 접속, Electron 실행은 하지 않는다. 테스트는 모델 호출을 주입 함수로 대체해 오프라인으로 돌린다.
- 이 명세의 수치(분량 하한 등)는 **앱의 제작 기본값**이다. 코드 주석에 네이버 공식 기준처럼 쓰지 않는다.

## 1. 새 모듈: src/generator/searchBrief.js (생성 전 기획)

순수 함수 위주, 외부 호출 없음. 내보내기: INTENTS, classifyIntent, buildSearchBrief, filterAutocomplete, hasExperienceInput, STANDARD_VERSION.

STANDARD_VERSION = 'search-standard-v1-2026-10-04'.

### 1.1 의도 8종과 앱 기본값

| key | label | minChars(하한) | targetChars | minHeadings | requiredAnswers (id: label) |
|---|---|---|---|---|---|
| definition | 뜻·개념 | 700 | 900~1600 | 2 | meaning: 핵심 의미를 앞부분에서 정의 / example: 구체적인 예시 / distinction: 헷갈리는 개념과의 차이 |
| howto | 방법·절차 | 1200 | 1500~2500 | 3 | who: 대상·자격·조건 / prep: 준비물·필요 정보 / steps: 실제 진행 순서 / costTime: 비용·소요 시간(해당 시) / exception: 예외·실패 시 대처 |
| compare | 비교·추천 | 1200 | 1500~2500 | 3 | criteria: 비교 기준 / differences: 기준별 차이 / choice: 상황별 선택 안내 / limits: 한계·주의점 |
| experience | 경험·후기 | 1000 | 1300~2200 | 3 | when: 언제 무엇을 경험했는지 / pros: 좋았던 점 / cons: 아쉬운 점 / fit: 누구에게 맞는지 |
| place | 장소·방문 | 1000 | 1300~2200 | 3 | location: 위치·가는 방법 / hours: 운영 정보(시간·휴무) / cost: 비용 / tips: 방문 팁(예약·주차·대기 등 해당 시) |
| news | 최신 이슈 | 900 | 1200~2000 | 3 | what: 무슨 일이 언제 있었는지 / confirmed: 확인된 사실과 미확인 내용 구분 / background: 관련 배경 / status: 현재 상태·다음 일정 |
| service | 서비스·사이트 찾기 | 900 | 1200~2000 | 3 | operator: 운영 주체·정체 / access: 이용·접속 방법 / pricing: 무료·유료 범위 / caution: 이용 전 확인할 점 |
| general | 일반 정보 | 1000 | 1300~2200 | 3 | answer: 검색자의 핵심 질문에 대한 직접 답 / details: 근거 있는 세부 정보 / next: 독자가 다음에 할 일 |

### 1.2 classifyIntent({ keyword, topic, review, source, memo, paid, newsCount, factCount })

반환: { intent, ambiguous:boolean, reason:string }. 우선순위대로 첫 일치:

1. review에 places가 있거나 paid==='mine' → experience (ambiguous=false).
2. 키워드 패턴(공백 제거본과 원문 모두 검사):
   - experience: 후기|리뷰|내돈내산|사용기|솔직|써본|가본
   - howto: 방법|하는법|하는 법|보는법|보는 법|신청|발급|조회|등록|설정|해지|가입|계산|준비물|절차|순서|만들기|레시피|사용법|설치|가는법|가는 법
   - compare: 비교|vs|VS|추천|순위|장단점|뭐가 좋|어떤게|어떤 게|차이점|차이
   - definition: 뜻|의미|이란|란 무엇|개념|정의|유래
   - service: 사이트|어플|앱|홈페이지|바로가기|공식
   - place: 맛집|카페|가볼만한곳|가볼만한 곳|여행|코스|주차|숙소|명소|위치
   ('차이'는 definition보다 compare가 먼저다. '가는법'은 howto.)
3. topic이 restaurant/domestictravel/worldtravel → place.
4. source(링크형)가 있으면 news (ambiguous=false).
5. familyOf(topic)==='A' 이거나 topic이 society/business/sports/game 이고 (newsCount+factCount)>0 → news (ambiguous=false).
6. 그 외 → general, ambiguous=true (예: '사주 궁합').

### 1.3 filterAutocomplete(keyword, list, intent)

- 메인 키워드와 같은 문자열, 빈 값 제거. 후보마다 classifyIntent({keyword:후보, topic})의 키워드 패턴 결과를 본다.
- 후보의 패턴 의도가 메인 의도와 같거나, 후보에 의도 패턴이 없으면(general) 통과. 다른 의도면 제외.
- 최대 3개. 반환: { selected:[], excluded:[] }.

### 1.4 hasExperienceInput({ review, paid, memo })

review.places 존재 || paid==='mine' || paid==='sponsored' || memo.trim() 존재 → true.

### 1.5 buildSearchBrief({ keyword, topic, review, source, memo, paid, style, autocomplete, newsArticles, keywordFacts, officialFacts, placeReviews })

반환 객체:

    { version, intent, intentLabel, ambiguous, reason,
      requiredAnswers:[{id,label}], minChars, targetChars:[min,max], minHeadings,
      autocomplete:{selected,excluded},
      evidence:{ news:n, facts:n, official:boolean, reviews:n, experienceInput:boolean },
      preHoldReasons:[], warnings:[] }

- preHoldReasons(생성 전에 확인되는 보류 사유):
  - intent==='news' 이고 news=0, facts=0, source 없음 → '최신 이슈 글인데 확인한 기사·뉴스 자료가 없음'.
  - intent==='experience' 이고 experienceInput=false → '후기 글인데 직접 경험 입력(리뷰 장소·내돈내산·경험 메모)이 없음'.
- warnings: ambiguous면 '검색 의도가 하나로 정해지지 않음 — 원고 범위를 검수하세요'. 경험형 말투(TONES_WITH_NOTE에 포함된 style)인데 experienceInput=false면 '경험형 말투지만 경험 입력이 없어 정보 전달 문체로 작성함'.

## 2. 새 모듈: src/generator/searchContentCheck.js (생성 후 내용 검수)

- checkRequiredAnswers({ post, brief, run }) — run 기본값은 runClaude를 haiku 모델('claude-haiku-4-5-20251001')로 부르는 함수. 테스트에서는 주입한다.
- 프롬프트: 원고 제목+블록 텍스트(번호 붙인 블록, 표/Q&A 포함)와 requiredAnswers를 주고, 각 id에 대해 {"id","covered":true|false,"blocks":[블록번호],"note":"한 줄"} JSON만 받는다. "covered는 해당 내용이 구체적으로 답해졌을 때만 true. 키워드 반복·일반론은 false."
- '(해당 시)'가 붙은 항목은 원고 주제에 해당하지 않으면 covered=true, note='해당 없음'으로 처리하도록 지시.
- 반환: { ran:true, items:[...], missing:[{id,label}] }. 호출/파싱 실패 시 { ran:false, items:[], missing:[], reason }. 관대한 JSON 파싱은 factCheck.js의 parseLoose 방식과 같게(필요하면 factCheck.js에서 parseLoose를 export해서 재사용).
- detectExperienceClaims(post) — 순수 함수. title, text, quote, qna(question+answer) 블록에서 1인칭 경험 단정 표현을 찾아 [{text(최대 80자), blockIndex}] 반환. 정규식 기준(공백 허용):
  - (제가|저는|저도|직접|실제로)\s*(가\s*보|가\s*봤|다녀|방문해|먹어\s*보|먹어\s*봤|써\s*보|써\s*봤|사용해\s*보|사용해\s*봤|구매해|사\s*봤|사서|타\s*봤|타\s*보|해\s*보니|해\s*봤|입어\s*보|발라\s*보)
  - 내돈내산|직접\s*(방문|구매|사용|시술|체험)
  - "~라고 하더라고요", "후기를 보면" 같은 전달 문장은 매칭되지 않게 한다(위 정규식 그대로면 대체로 안 걸린다. 테스트로 확인).

## 3. validateSearchPost 교체 (generateSearchPost.js)

시그니처: validateSearchPost(post, searchTopic, brief, ctx) — ctx = { keyword, experienceInput }. brief가 없으면 general 기본값으로 동작(하위 호환).

**삭제:** 본문 1,800자 고정 하한, 소제목 4개 고정 하한, hasMustInclude 표시.

이슈를 severity로 구분해 { severe:[], warnings:[] }로 모은다. 기존 issues 배열은 severe+warnings 합친 문자열 배열로 유지(UI·재시도 호환).

severe(재생성 사유):

- 본문 글자수 < brief.minChars (집계는 기존 blockTextLength 그대로)
- 소제목 수 < brief.minHeadings
- 마지막 블록이 heading / 빈 text 블록 / 본문 없는 소제목 (generatePost.js 655행 validatePost의 완결성 검사와 같은 규칙. 본문 판정은 15자 이상 text)
- 인용구 > MAX_QUOTES
- description 비어 있음
- 제목에 메인 키워드가 없음: 키워드가 있을 때, 공백 제거 후 제목에 키워드 전체가 포함되거나 키워드를 공백으로 나눈 핵심어가 모두 포함되면 통과
- experienceInput=false 인데 detectExperienceClaims 결과가 있음 → '직접 경험 근거 없는 1인칭 경험 표현 N건'

warnings: 본문이 targetChars 최대치의 1.6배 초과('불필요하게 긴 원고일 수 있음'), heading 문장형 등 기존 경고성 항목은 없으면 생략해도 된다.

반환 필드: ok(severe 0), issues, severe, warnings, quoteCount, headingCount, imageCount, tableCount, mapCount, qnaCount, bodyLength, minLength(brief.minChars), intent, topic.

## 4. 생성 흐름 변경 (generateSearchPost)

1. 기존 자료 수집이 끝난 뒤(autocomplete, keywordFacts, newsArticles, placeReviews, officialFacts 준비 후) buildSearchBrief 호출. officialFacts 인자는 이미 opts에 있다.
2. 새 옵션 strictEvidence(boolean, 기본 false). strictEvidence && brief.preHoldReasons.length → **모델 호출 없이** { post:null, status:'hold', holdReasons:brief.preHoldReasons, brief, validation:null, attempts:0 } 반환.
3. buildSearchUserPrompt에 brief 전달(5장 참조). autocomplete 원본 대신 brief.autocomplete.selected를 프롬프트에 사용.
4. 시도마다: 파싱·기존 후처리(그대로 유지) → validateSearchPost → severe가 없을 때만 checkRequiredAnswers 실행(모델 비용 절약). missing이 있으면 severe에 '필수 답변 누락: label들' 추가.
5. 재시도 조건: severe가 하나라도 있으면 다음 시도. retry 정보에는 severe 목록과 missing label 목록을 넣는다.
6. **후보 선택 삭제·교체:** "본문이 더 긴 후보" 선택 로직을 삭제. 점수 = severe 개수×100 + missing 개수×10 + warnings 개수, 낮을수록 좋음, 동점이면 먼저 나온 후보.
7. _finish에서 factCheck(기존 그대로) 후 status 계산:
   - hold: brief.preHoldReasons 있음(strictEvidence=false라 생성한 경우) / 경험 단정 severe 남음 / factCheck.highCount ≥ 1
   - review: hold 아님 + (severe 남음 / missing 있음 / contentCheck.ran=false / factCheck.ran=false 또는 issues 있음 / brief.ambiguous / brief.warnings 있음)
   - ready: 그 외
   - holdReasons, reviewReasons 문자열 배열을 함께 반환.
8. 반환 객체에 추가: status, holdReasons, reviewReasons, brief, contentCheck. 기존 필드(post, validation, meta, attempts, factCheck, scrapeHealth)는 유지.
9. module.exports에 validateSearchPost, pickBestCandidate(테스트용), computeSearchStatus(테스트용)를 추가 export.

## 5. 프롬프트 수정 (buildSearchPrompt.js)

buildSearchSystemPrompt(topicKey)는 그대로 두되 아래 문장을 교체·삭제한다. 의도별 지시는 user prompt에 brief로 넣는다.

**삭제 또는 교체할 주장/규칙:**

| 위치(현재) | 처리 |
|---|---|
| 108 제목 구성 = 메인+세부+후킹 | 교체: "제목 = 검색 대상 + 이 글이 답하는 실제 질문·범위. 후킹은 선택이며 내용과 일치할 때만. 숫자는 본문에 실제로 있을 때만." |
| 118 첫 문장 훅(퀵백→노출 끊김 인과) | 교체: "첫 문단에 핵심 답과 적용 조건(대상·날짜·예외)을 먼저 준다. 상투적 인사·긴 공감 서론 금지." 도입 다양성 규칙(119, 121)은 유지 |
| 122 분량 1,800~2,500자 | 교체: "분량은 아래 [원고 기획]의 목표 범위를 따르되, 필요한 답이 끝나면 늘리지 않는다." |
| 123 미달이면 섹션 추가, 축약 금지 | 삭제 |
| 127 소제목 4개 이상, 소제목마다 문단 2개 이상 | 교체: "소제목은 [원고 기획]의 최소 개수 이상, 각 소제목 아래 실제 본문 text 최소 1개" |
| 131 순수 AI글은 색인 제거 | 교체: "AI 사용 여부가 아니라 근거·정확성·추가 가치가 품질을 가른다. 제공된 자료를 넘는 사실을 만들지 말고, 조건별 정리·비교·계산처럼 독자에게 새로 도움이 되는 정리를 더한다." |
| 133 외부 링크=검색 노출 저하·저품질·제재 위험 | 교체: "본문에 긴 URL을 붙여넣지 않는다. 공식 서비스·기관은 정확한 이름과 도메인(예: gov.kr)을 텍스트로 안내한다." (제재 주장 삭제) |
| 135 이미지 5~10장(상위노출 글 평균) | 교체: "본문 이미지는 내용과 정확히 맞는 것만 4~8장 목표. 맞는 대상이 부족하면 적게 넣는다." ('상위노출 평균' 삭제) |
| 172 표 1~2개 필수 | 교체: "비교·수치·일정처럼 표가 이해를 돕는 내용이 있을 때만 표 1~2개." |
| 173 qna 2~4개 + 능동 반응이 노출에 유리 | 교체: "qna는 본문에 없는 구체적 궁금증이 근거와 함께 있을 때만 0~3개. 마지막에 commentCta." (노출 유리 주장 삭제) |
| 174 질문 4개 뽑아라 | '4개' → '최대 3개', 근거 없으면 생략 유지 |
| 186 title 설명 | '자연어 문장형 제목(세부 인텐트...)' → '검색 대상과 이 글이 답하는 질문을 정확히 담은 제목(자극단어 금지)' |

**user prompt 변경 (buildSearchUserPrompt):**

- 인자에 brief 추가.
- 키워드 줄 뒤에 [원고 기획] 블록 추가:

      [원고 기획 — 이 글의 기준]
      - 검색 의도: {intentLabel}{ambiguous면 ' (불명확 — 아래 핵심 질문 하나에 집중)'}
      - 반드시 답할 것: label들(번호 목록). 각 항목은 근거가 있는 구체적 내용으로 답한다. 근거가 없으면 '확인 필요'를 분명히 쓰고 지어내지 않는다.
      - 분량 목표: {targetChars[0]}~{targetChars[1]}자(공백 포함), 소제목 {minHeadings}개 이상
      - 주제 필수 구성(t.mustInclude)은 이 의도에 맞는 항목만 고른다.

- 자동완성 블록(현재 360~369행) 교체: brief.autocomplete.selected가 있을 때만 "[같은 목적의 세부 질문 후보] a / b / c — 이 글 범위에 맞으면 제목·소제목에 1개까지 자연스럽게 반영. 맞지 않으면 쓰지 않는다." **'반드시 붙여라', '메인 단독 제목은 노출 안 된다', '자동완성 단어 하나하나를 소재로' 문장은 삭제.**
- 경험 메모(322~325행) 교체: "[글쓴이가 실제로 겪은 것] {memo}" + "- 메모에 적힌 사실만 1인칭 경험으로 쓴다. 메모에 없는 시간·가격·대화·맛·감각 같은 디테일을 추가하지 않는다. 부족한 분량은 근거 있는 정보로 채운다." ('실제 겪은 것처럼 생생하게 확장' 삭제)
- 경험형 말투인데 경험 입력이 없으면(brief.evidence.experienceInput=false 이고 style이 TONES_WITH_NOTE에 포함) toneGuide 대신 "말투는 {style}의 어조만 참고하고, 1인칭 경험 단정 없이 자료를 전달하는 문체로 쓴다." 출력.
- 공식 정보가 있을 때(384~396행 블록) 다음 문장 추가: "- 글 마지막(commentCta 전) text 블록에 '참고한 공식 자료: 기관명(도메인)'을 한 줄로 적는다. 도메인은 위 공식 페이지 주소에서만 가져온다."
- 재생성 블록(440~451행) 교체: retry.severe(또는 issues)와 retry.missing을 나열하고 "누락된 답을 근거 있는 내용으로 채우고, 지적된 문제만 고친다." **'반드시 N자 이상 훨씬 더 길게' 문장 삭제.** 길이 미달이 severe에 있을 때만 "목표 분량 하한을 넘기되 같은 말을 반복하지 않는다."
- 썸네일 각도(468~473행): THUMB_ANGLES에서 '손실회피(...)', '\"이거 실화?\" 식 궁금증 자극' 삭제. 필수 점검 ③ '손실회피·숫자·반전·도발 중 하나로 후킹' 삭제 → "③내용과 일치하지 않는 과장·공포 조장 표현 금지". 마지막 문장 '검색 상위노출용 글 한 편을 생성하라' → '위 기준으로 검색용 글 한 편을 생성하라'.

## 6. searchTopics.js

- 상단 주석 5·7행의 'AI 브리핑 발췌·검색 노출에 유리한 필수 구성요소' → '이 주제에서 자주 필요한 내용 후보(의도에 맞는 것만 사용)'.
- restaurant mustInclude의 '(순수 AI글은 검색에서 걸러짐)' 삭제 → '(직접 방문 정보가 없으면 후기 전달형으로)'.
- SEARCH_MIN_LENGTH 주석의 'AI 브리핑이 본문 2,000바이트↑ 문서 우대' 삭제. 상수는 하위 호환용으로 남기고 주석에 '검색용 분량 기준은 searchBrief.js 의도별 값 사용'이라고 적는다. 사용처(generateSearchPost, buildSearchPrompt)에서 더는 하드 기준으로 쓰지 않는다.

## 7. IPC·preload·UI

- preload.js generateSearch: 12번째 인자 opts 추가 → invoke payload에 opts 포함. 기존 11개 인자 순서 유지.
- main.js generate:search: opts.auto===true면 generateSearchPost에 strictEvidence:true 전달. 반환에 status, holdReasons, reviewReasons, brief(요약: intent, intentLabel, requiredAnswers, ambiguous), contentCheck 추가.
  - result.post가 null(생성 전 보류)이면 pushSearchRecent, logTokenUsage를 건너뛰고 { ok:true, status:'hold', holdReasons, post:null, ... } 반환.
  - 생성 결과마다 userData/search-quality.jsonl에 한 줄 append(실패해도 무시): { at, version, keyword, topic, intent, ambiguous, status, holdReasons, reviewReasons, title, bodyLength, attempts, missing:[ids] }.
- app.html 검색용 생성(1203행 근처):
  - 호출에 opts { auto: !!window._autoMode } 전달.
  - res.status==='hold' && !res.post → 편집기 주입하지 않고 상태줄에 보류 사유 표시, window._genResult='hold:'+사유.
  - res.status==='hold' && res.post && window._autoMode → 주입하지 않고 window._genResult='hold:'+사유 (자동 저장 방지).
  - 수동 모드에서 post가 있으면 기존처럼 주입하고, 완료 문구를 상태에 맞게: ready '검색용 글 작성됨', review '검수 후 발행하세요', hold '발행 보류 — 사유 확인'.
- renderGenWarnings: 맨 위에 상태 배지 한 줄(✅ 발행 준비 / 🔍 검수 필요 / ⛔ 발행 보류) + 의도 라벨 + holdReasons/reviewReasons 목록 + contentCheck.missing 라벨. 기존 팩트·수집 경고는 그대로 이어 붙인다. status가 없으면(홈판) 기존 동작.
- autoRun(4476행 근처): window._genResult가 'hold'로 시작하면 저장 없이 finishAuto('발행 보류: '+사유)로 끝낸다. 에러 판정 로직은 유지.
- 검색용 안내 문구(689행) 교체: "✅ 검색용은 키워드의 검색 의도를 먼저 정하고, 그 의도에 필요한 답·근거를 기준으로 작성·검수해요. 직접 경험은 입력한 내용만 사용해요." 워터마크 안내 줄은 유지.

## 8. 테스트 (scripts/tests/search-standard.test.js, node:test, 오프라인)

1. classifyIntent: '사주 뜻'→definition, '사주 보는 법'→howto, '무료 사주 사이트'→service, '온라인 사주 후기'→experience, '사주 궁합'(topic 'daily')→general ambiguous, '아이폰 17 vs 갤럭시'→compare, 키워드 '성수 맛집'→place, review.places 있음→experience.
2. filterAutocomplete('사주 뜻', ['사주 뜻 풀이','사주 보는 법','무료 사주 사이트','사주 뜻 한자'], 'definition') → 다른 의도 후보 제외, 최대 3개.
3. buildSearchBrief: 후기 의도+경험 입력 없음 → preHoldReasons 존재. news 의도+자료 0 → preHoldReasons 존재.
4. 앞 조사에서 재현한 반복문 사례(무관한 제목, 소제목 4개, 무관 반복 본문, description)로 validateSearchPost(society, brief general, keyword '청년 지원금') → ok=false, 제목 키워드 누락 severe 포함.
5. checkRequiredAnswers에 가짜 run 주입: covered false 항목 → missing에 포함. run이 throw → ran=false.
6. detectExperienceClaims: '제가 직접 가보니 좋았어요' 검출, '후기를 보면 맛있다고 하더라고요' 미검출, '내돈내산' 검출.
7. pickBestCandidate: severe 0·짧은 후보가 severe 1·긴 후보보다 선택됨.
8. computeSearchStatus: factCheck.highCount 1 → hold, contentCheck.ran false → review, 모두 통과 → ready.
9. 프롬프트 회귀: buildSearchSystemPrompt('society') + buildSearchUserPrompt(brief 포함 최소 인자) 결과에 '색인에서 제거', '상위노출 글 평균', '검색 노출 저하·저품질·제재', '훨씬 더 길게', '메인 단독 제목은 경쟁이 치열해' 문자열이 없고, '[원고 기획' 이 포함됨.

## 9. 완료 조건

- node --test scripts/tests/*.test.js 전부 통과(기존 키워드 테스트 포함).
- npm run check 통과.
- 변경 파일 목록과 각 변경 요약, 테스트 출력 요약을 보고. 커밋하지 않는다.
