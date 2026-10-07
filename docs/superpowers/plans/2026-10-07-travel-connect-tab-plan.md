# 여행커넥트 탭 Implementation Plan — 기존 앱 확장

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. SNS는 후순위이며 이 문서는 구현 계획이다. 사용자의 구현 요청에 따라 격리 작업 공간에서 단계별 개발·검토를 진행한다.

**Goal:** 현재 앱의 키워드 조사·검색 원고 생성·보관함·에디터·블로그 성과 기능에 여행커넥트 탭을 추가한다.

**Architecture:** 기존 `generateSearchPost`와 주제 원고 흐름을 재사용한다. 상품 근거·여행 조건·명시적 `connectKind`·제휴 링크 보존·추가 검수만 도메인 모듈로 보강한다. 여행과 쇼핑은 공통 제작 흐름을 공유하되 상품 상세와 정책은 분리한다. 첫 구현은 여행 블로그이며 SNS와 쇼핑 전용 탭은 후속 범위다.

**Tech Stack:** 기존 Electron 43, CommonJS, Ajv, Cheerio, ExcelJS, Claude agent SDK, node:test. 첫 구현에는 SNS 라이브러리·새 모델 호출 엔진·별도 원고 보관함을 추가하지 않는다.

**Spec:** `docs/topics/travel-connect-tab-spec.md`. 2026-10-07 후속 요청에 따라 SNS를 후순위로 옮기고 기존 앱 재사용을 우선한 수정안이다.

## Global Constraints

- 첫 산출물은 여행 상품 기반 검색용 네이버 블로그 원고 1편이다. 홈판 원고는 후속 범위다. 여행 기획·작성은 Opus, 1차 대조는 기존 Haiku, 필수 링크·고지 검사는 코드 규칙을 사용한다.
- 링크 발급은 사용자가 공식 브랜드커넥트 또는 공식 크리에이터 도구에서 수행한다. 앱은 상세 URL과 발급 링크 원문을 각각 등록받는다.
- 일반 상세 URL을 제휴 링크로 간주하거나 AI로 발급 링크를 만들어내지 않는다.
- `connectKind:'travel'|'shopping'`을 등록부터 원고·보관·에디터까지 전달한다. 제목·키워드·URL 도메인으로 서비스 종류를 덮어쓰지 않는다.
- 여행 고지는 `이 포스팅은 네이버 여행 커넥트 활동의 일환으로, 예약 발생 시 수수료를 제공받습니다.`이다.
- 쇼핑 고지는 `이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 판매 발생 시 수수료를 제공받습니다.`이다.
- 링크 원문에 UTM 추가·쿼리 재정렬·퍼센트 인코딩 재작성·임의 단축을 하지 않는다.
- 기존 사주·구버전·프로필·보관함·예약·에디터 동작과 작업 중인 다른 변경을 보존한다.
- 원고는 기존 `topic-drafts.json`, 프로필은 `topic-profiles.json`, 블로그 성과는 기존 저장소에서 topicId로 구분한다.
- 상품·출처·설정만 `%APPDATA%/blog-auto/connect/`의 버전 있는 JSON으로 추가한다.
- 수집·모델·시간·파일 I/O는 주입 가능하게 하고 테스트에서 네트워크·실제 Claude 호출을 하지 않는다.
- SNS 생성·SNS API·자동 링크 발급·자동 발행·쇼핑 전용 탭·별도 제휴 실적 대시보드는 첫 완료 기준에 포함하지 않는다.
- `keyword-workflow/`는 별도 AGENTS.md 범위이므로 이 계획에서 수정·실행하지 않는다.

## Review Focus

1. 쇼핑 캠핑용품은 제목에 여행·캠핑이 있어도 쇼핑 고지여야 한다. 여행과 쇼핑 고지를 명시적 종류로 결정한다. Task 1·5.
2. 단축 링크·중복 쿼리·인코딩이 저장·원고 수정·에디터 전달 뒤에도 원문과 같아야 한다. Task 1·4·5.
3. 상품 비교표의 출발일·인원·객실·가격·팁도 검수해야 한다. 기존 factCheck의 텍스트 블록 검사만으로 완료 처리하지 않는다. Task 2·4.
4. 공용 보관함이 200개인 상태에서 여행 원고 추가가 기존 사주 원고를 자동 삭제하지 않아야 한다. 수정·상품 갱신 후 재검수해야 한다. Task 4.
5. 검색 차단·일부 상품 조건 미확인·새 connectContext가 없는 기존 생성 요청을 각각 올바르게 처리해야 한다. Task 2·3·6.

## 파일별 책임

| 추가 파일 | 책임 |
|---|---|
| `src/connect/policy.js` | 서비스 종류·고지·정책 버전·링크 보존 |
| `src/connect/products.js` | 상품/옵션/출처 스키마·필드 검증·스냅샷·신규 상품 저장 |
| `src/connect/travel.js` | 여행 필수 질문·출발일/인원/객실·포함/불포함 조건 |
| `src/connect/keywords.js` | 기존 조사 결과의 여행 분류·상품 매칭·추천 이유 |
| `src/connect/check.js` | 생성/수정/내보내기 시 제휴 조건 추가 검수 |
| `app/travel-connect.html/js/css` | 기존 메인 화면 안의 여행 전용 입력 패널 |

기존 수정 대상은 `src/topics/index.js`, `src/topics/drafts.js`, `src/generator/generateSearchPost.js`, `buildSearchPrompt.js`, `searchBrief.js`, 필요 시 `factCheck.js`, `electron/main.js`, `electron/preload.js`, `app/app.html`, `scripts/check.js`, `README.md`, `docs/STATUS.md`다.

기존 `src/topics/topicContext.js`의 사주 UTM/운영자/무료→유료 맥락은 여행에 호출하지 않는다. 별도 여행 생성기·별도 drafts/metrics 모듈은 만들지 않는다. `src/topics/editorDelivery.js`의 기존 `strictInject`와 성공 확인 흐름은 유지한다.

## 공통 데이터 계약

- `ConnectSource`: `{id,url,accessLevel,publishedAt|null,collectedAt,excerpt}`. accessLevel은 `full-page|search-snippet|user-excerpt`. 사용자가 원문을 붙인 경우 그 접근 수준을 보존하고 공식 기관 자료로 위장하지 않는다.
- `ConnectFact`: `{field,value,sourceId,excerpt,status,checkedAt}`. status는 `verified|unverified|conflict|missing`.
- `ConnectProduct`: `{id,connectKind,name,provider,detailUrl,affiliateUrlRaw,profileKey,eligibility,variants,facts,travelDetails|null,shoppingDetails|null,images}`. eligibility는 `verified|unknown|excluded`.
- `ConnectVariant`: `{id,currency,amountMinor,priceCheckedAt,options,departureDate|null,adults|null,children|null,roomBasis|null}`. 돈은 최소 통화 단위 정수로 저장하고 다른 통화를 근거 없이 합하지 않는다.
- `ConnectContext`: `{connectKind,productIds,variantIds,productSnapshots,snapshotHash,sources,verifiedFacts,uncertainFields,requiredAnswers,experience,disclosureLine,links,policyVersion,promptBlock}`.
- 기존 생성 result에 `connect:ConnectContext`를 추가한다. 기존 `post/status/holdReasons/reviewReasons/assets/meta`를 사용하고 result의 형식을 교체하지 않는다.

쇼핑의 상세 스키마와 수수료·실적 계산은 첫 구현에 포함하지 않는다. 공통 종류와 고지 분리를 미리 고정하고, 여행 전용 필드와 혼합하지 않는다.

## Task 1: 서비스 종류·상품·발급 링크 등록

**Files:** Create `src/connect/policy.js`, `products.js`, `travel.js`; Test `scripts/tests/connect-products.test.js`.

**Interfaces:**

- `getConnectDisclosure(connectKind) -> string` — 알 수 없는 종류는 오류.
- `validateAffiliateUrl(raw) -> {valid,raw,reason}` — trim 외 원문 재직렬화 없음.
- `normalizeConnectProduct(input,{sources,now}) -> ConnectProduct`.
- `buildConnectContext({products,variantIds,sources,experience,policyVersion,now}) -> ConnectContext`.
- `readConnectCatalog(file,{fs}) -> {version:1,products,sources}`; `writeConnectCatalog(file,value,{fs}) -> void` — 원자적 쓰기, 손상 파일 덮어쓰기 금지.

- [x] 테스트 `explicit_kind_selects_disclosure`: 쇼핑 캠핑텐트는 쇼핑 문구, 여행 패키지는 여행 문구, 종류 unknown은 오류.
- [x] `preserves_affiliate_bytes`: 중복 쿼리·`%2F`·단축 링크 원문 유지, javascript/file URL 거부.
- [x] `detail_url_is_not_issued_affiliate_url`: 상세 URL만 입력하면 제휴 완료로 표시하지 않음.
- [x] `variants_keep_departure_and_room_identity`: 출발일·인원·객실이 다른 가격을 섞지 않음.
- [x] `source_review_is_required`: 출처 없는 가격·URL만 붙인 미검토 필드는 verified로 승격하지 않음.
- [x] `node --test scripts/tests/connect-products.test.js` 미구현 실패 확인.
- [x] 위 함수·Ajv 스키마·여행 상세 필드 구현. 상품/출처만 신규 저장하며 기존 프로필과 원고는 읽기 접점 재사용.
- [x] 같은 명령 PASS 확인.

## Task 2: 기존 검색 생성기와 상품 근거 연결

**Files:** Modify `src/generator/generateSearchPost.js`, `buildSearchPrompt.js`, `searchBrief.js`, 필요 시 `factCheck.js`; Test `scripts/tests/connect-generation.test.js`.

**Interfaces:**

- 기존 `generateSearchPost({...existingOptions,connectContext})`에 선택 인자 추가.
- `buildSearchUserPrompt({...existingOptions,connectContext})`가 verified 상품 조건과 필요한 질문을 포함한다.
- `buildSearchBrief({...existingOptions,connectContext})`는 상품 선택/예약 전 확인의 필수 답변을 보강한다.
- 연결 결과는 기존 형식과 추가 `connect` 메타를 반환한다.

- [x] `no_context_preserves_legacy_generation`: connectContext가 없는 기존 요청의 수집/프롬프트/검수가 그대로 동작함을 assert.
- [x] `uses_existing_search_generation_and_runner`: 별도 생성 엔진 없이 기존 run/JSON 파싱/원문 대조 경로 사용.
- [x] `product_body_keeps_provenance`: 상품 상세 원문·사용자 발췌를 각각의 provenance로 대조하며 검색 스니펫을 상세 원문으로 승격하지 않음.
- [x] `connect_facts_override_experience_requirement`: 직접 경험이 없으면 정보/비교형. 국내여행·세계여행 기본 유형의 방문 경험 요구를 새 맥락에서 강제하지 않음.
- [x] `unrelated_news_does_not_become_product_evidence`: connect 요청은 등록 상품 근거를 우선, 일반 뉴스·후기 수집이 상품 가격·취소 조건의 근거를 대체하지 않음.
- [x] `node --test scripts/tests/connect-generation.test.js` 실패 확인.
- [x] connectContext가 있는 요청에만 수집/기획 분기 보강. 국내 상품은 기존 `domestictravel`, 해외는 `worldtravel` 주제와 상품 선택 질문을 연결. 맥락 없는 기존 주제 요구는 유지.
- [x] 상품 근거는 기존 원문 수집/대조 입력에 명시 타입으로 연결. 출처 판별 함수 수정은 상품 타입만 제한적으로 추가.
- [x] 같은 명령 PASS와 `node --test scripts/tests/search-standard.test.js scripts/tests/evidence-policy.test.js` 확인.

## Task 3: 기존 키워드 조사에 여행 상품 매칭 추가

**Files:** Create `src/connect/keywords.js`; Reuse `src/keyword/report.js`, `expand.js`, `integratedSerp.js`; Test `scripts/tests/connect-keywords.test.js`.

**Interfaces:**

- `matchConnectKeywords({seed,adsRows,autocomplete,questions,products,observations}) -> Array<{keyword,monthlyPc,monthlyMobile,monthlyTotal,productIds,fit,reasons}>`.
- fit은 `fit|conditional|unfit`. 추천 순서는 상품 적합성→근거→질문 구체성→검색 관찰→시기→실제 검색량.

- [x] `preserves_volume_uncertainty`: `<10`·결측·자동완성 검색량 미제공 유지.
- [x] `matches_region_audience_and_product`: 실제 지역·대상·확인 조건으로만 상품 매칭, 노쇼핑 unknown은 conditional.
- [x] `blocked_serp_is_not_low_competition`: 차단은 관찰 실패, 광고 경쟁지수를 SEO 난이도로 사용하지 않음.
- [x] `node --test scripts/tests/connect-keywords.test.js` 실패 확인.
- [x] 기존 XLSX 파싱·자동완성·검색 guard를 호출하고 여행 분류만 추가. 독립 키워드 수집 엔진을 만들지 않음. 질문은 사용자 직접 입력·공개 자료 발췌로 시작.
- [x] 같은 명령 PASS와 기존 keyword-report 테스트 확인.

## Task 4: 기존 보관함에 연결하고 수정·내보내기 검수

**Files:** Create `src/connect/check.js`; Modify `src/topics/drafts.js`, `electron/main.js`의 주제 보관 경로; Test `scripts/tests/connect-drafts.test.js`.

**Interfaces:**

- `checkConnectPost(post,{connectContext,currentProducts,now}) -> {status,holdReasons,reviewReasons}`.
- 기존 `addDraft/updateDraft/listDrafts`와 result.connect 사용. 여행 topicId는 `travel-connect`.
- 기존 주제 원고 내보내기 직전에 currentProducts로 검수하고 hold는 전달하지 않음.

- [x] `checks_tables_and_qna`: 표의 가격/출발일/포함·불포함과 FAQ까지 전체 원고를 검수. 기존 factCheck의 text/heading/quote 검사만으로 완료 처리하지 않음.
- [x] `holds_missing_disclosure_changed_link_or_fake_experience`: 고지 누락·링크 변경·경험 입력 없는 내돈내산/직접 여행은 hold.
- [x] `edited_and_stale_drafts_recheck`: 수정·상품 갱신·24시간 이상 가격 확인 경과 시 현재 조건으로 재검수. 24시간은 앱 운영값임을 UI에서 표시.
- [x] `travel_save_does_not_evict_saju_drafts`: 기존 보관함 200개 시 신규 제휴 저장은 용량 오류, 기존 원고 자동 삭제 없음.
- [x] `keeps_existing_result_shape`: 사주 보관함 읽기/수정/목록 형식이 유지됨.
- [x] `node --test scripts/tests/connect-drafts.test.js` 실패 확인.
- [x] 기존 보관함에 상품 스냅샷과 connect 메타 저장. 읽을 때 이전 검수 상태를 최종 전달 허가로 사용하지 않음. 전체 블록 텍스트 추출과 필수 상품 조건 대조 구현.
- [x] 같은 명령 PASS와 `node --test scripts/tests/topic-drafts.test.js scripts/tests/topic-saju.test.js` 확인.

## Task 5: 기존 주제 탭·IPC·상품 카드·에디터 확장

**Files:** Create `app/travel-connect.html/js/css`; Modify `src/topics/index.js`, `electron/main.js`, `electron/preload.js`, `app/app.html`, `scripts/check.js`; Test `scripts/tests/connect-ui.test.js`.

**Interfaces:**

- `generate:topic` request에 여행일 때만 `productIds,variantIds` 추가. main이 저장 상품을 읽어 맥락을 구성한다.
- 기존 `topicDrafts:list/generate/import/update/delete`를 travel-connect topicId로 재사용. batch는 선정 상품/옵션을 각 요청에 전달.
- 새 상품 접점만 `connect:catalog`, `connect:saveProduct`, `connect:prepareKeywords`, `connect:prepareDelivery` IPC로 제공한다.
- preload는 `connectCatalog/connectSaveProduct/connectPrepareKeywords/connectPrepareDelivery`만 추가. 기존 에디터 메서드와 프로필 메서드 사용.
- 신규 여행 UI는 `mountTravelConnect({root,api,editorDelivery})`로 연결하고 탭 입력·이미지·생성 상태를 분리한다.
- 기존 에디터의 고지 선택 함수는 connectKind 명시값을 우선. 값 없는 구버전 요청은 기존 동작 보존.

- [x] `tab_state_is_isolated`: 사주/여행/구버전 프로필·키워드·사진·생성 상태가 섞이지 않음.
- [x] `same_kind_survives_save_edit_delivery`: 여행/쇼핑 구분이 보관함·수정·에디터에서 유지, 캠핑용품 고지 오분류 없음.
- [x] `raw_link_and_disclosure_survive_editor_card`: 기존 카드 처리 후 원문 링크·정확한 고지 유지. 중복 고지 제거는 서비스 종류를 바꾸지 않음.
- [x] `invalid_ipc_is_rejected`: 임의 경로·스키마·발신자·renderer의 policy override 거부.
- [x] `external_scripts_are_checked`: 새 UI JS의 window.api 호출·문법을 scripts/check.js가 점검.
- [x] `node --test scripts/tests/connect-ui.test.js` 실패 확인.
- [x] 여행 탭에 상품 등록·키워드·기획·사진·생성·기존 보관함/성과 연결. 원고 출력은 기존 finishGen과 strictInject 사용. SNS 버튼·라이브러리는 추가하지 않음.
- [x] 같은 명령과 `npm run check` PASS 확인. 격리 Electron에서 탭 전환·상품 비교표·링크·hold·긴 한글 이름·보관 원고 수정 확인.

## Task 6: 기존 기능 회귀·실상품 검수·운영 문서

**Files:** Modify `README.md`, `docs/STATUS.md`; 기존 회귀 테스트와 connect 테스트 사용.

- [x] `npm run check`, `npm test`, `npm run test:rendered-browser` 실행하고 전체 출력·종료 코드 확인.
- [x] 다른 작업의 수정과 기존 실패는 변경 전 기준을 확인해 구별하고 통과로 보고하지 않음.
- [ ] 실제 여행 상품 5~10개를 등록해 링크 원문·출발일·가격·팁·옵션·포함/불포함·취소·이미지 사용권을 사람이 대조.
- [x] 직접 경험 미입력 원고가 정보/비교형인지, 보관함 수정 후 재검수가 작동하는지 확인.
- [x] README에 사용자가 링크를 발급하는 흐름, 상세 URL과 제휴 링크 차이, 가격 재확인·수동 발행을 설명.
- [x] STATUS에 기존 기능 재사용 접점, 구현·검증 범위, SNS/쇼핑 전용 탭/자동 링크 발급 미구현을 명확히 기록.
- [x] 검토 가능한 변경과 검증 결과를 정리. 요청하지 않은 외부 발행·배포·머지는 하지 않음.

최종 독립 검토 통과 후 원본 앱 작업 폴더에 적용했고, 적용 위치에서 다시 검증했다. 오프라인 최종 검증: 회귀 222개, 렌더 브라우저 8개, 정적 검사와 여행 패널 Electron 검사가 통과했다. 실제 앱의 전달 훅은 가짜 이미지 처리·에디터와 함께 실행해 최종 재검사·보류 차단·잠금 복원을 확인했다. 실상품 5~10개와 실제 네이버 에디터 검증은 별도 운영 확인으로 남긴다.

## 후속 확장 순서

1. 쇼핑 전용 탭: 같은 상품 등록·키워드·생성·보관·에디터 흐름에 스펙/옵션/배송/반품과 쇼핑 정책 어댑터를 추가한다. 상품별 수수료·직접/간접 실적·유입 24시간·집계 7일 우선순위를 여행 규칙으로 대체하지 않는다.
2. 공급사 상세페이지 자동 추출: 실제 상품 페이지와 허용된 접근 방법을 확인한 공급사부터 추가.
3. 제휴 실적: 공식 원본 파일의 열·집계 단위 확인 후 기존 블로그 성과와 별도 지표로 연결.
4. SNS: 검수된 블로그/상품 근거를 공유해 Threads·X 문안부터 추가. 수집 API와 자동 발행은 별도로 범위를 정한다.
5. 자동 링크 발급: 공식 API·연동 방법과 사용자 계정 권한이 확인된 경우에만 별도 설계. 현재는 사용자 발급·붙여넣기.

기존 앱 기반 첫 여행 블로그 버전의 공수는 8~12 개발일 추정이다. 새로운 생성기와 SNS를 포함했던 12~17일 추정을 대체하며 실제 재사용 접점 검증 결과로 조정한다. 체크박스는 실제 실행 상태를 기록한다. 실상품·실계정 검증은 입력 자료와 계정 동작을 확인하기 전까지 완료로 표시하지 않는다.
