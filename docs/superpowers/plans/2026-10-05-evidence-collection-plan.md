# Evidence Collection Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 공식 API 없이 근거 수집의 정확성, 오류 관찰 가능성, 제한 상태의 지속성과 Electron 검증을 개선한다.

**Architecture:** 기존 Electron/Node 수집 경로를 유지하고 카드별 구조화 결과와 호환 텍스트를 제공한다. guard와 health가 결과 상태를 보존하고 검색용 원고는 출처의 실제 내용으로 근거 충족 여부를 판단한다. 브라우저 테스트는 로컬 fixture와 격리 프로필을 사용한다.

**Tech Stack:** CommonJS JavaScript, Electron, node:test, Playwright 개발 도구. 검증에 필요한 최소 DOM 파서 의존성은 허용하되 도입 근거와 lockfile을 기록한다.

**Spec:** ../specs/2026-10-05-evidence-collection-design.md

## Global Constraints

- 구현 모델 gpt-6-luna, reasoning_effort=max.
- 공식 API 사용 불허. 기존 동작에 없는 인증 키·외부 서비스 도입 금지.
- 현재 branch에서 작업, 다른 사람의 변경 되돌리기 금지, 배포 금지. 구현 단계의 commit/push 제한은 후속 사용자 요청인 ‘커밋 푸시’로 해제되었으며, 현재 브랜치의 커밋과 원격 push를 진행한다.
- 원고 생성/에디터 입력의 외부 동작 및 사용자 로그인 정보를 검증용으로 사용하지 않는다.
- 모델 호출 없이 재현 가능한 regression test를 먼저 작성하고 실패를 확인한 후 고친다.
- 공개 자료만 제한된 크기로 캐시. 오류·제한을 성공 자료로 저장하지 않는다.

## Review Focus

- 첫 카드에 요약이 없을 때 다음 카드의 요약을 가져오지 않는가.
- 도메인 검사를 substring으로 해서 위장 도메인이나 검색 redirect를 신뢰하지 않는가.
- 저장 상태의 TTL·손상·프로세스 재시작 및 429가 실제 유예를 지키는가.
- 사용자 링크 주소만 있음/빈 본문/AI 요약만 있음이 원문 근거로 승격되지 않는가.
- 렌더 로드 오류와 제한 상태에서 성공 캐시·브라우저 fallback이 실행되지 않는가.

## Task 1 — 오류/제한 상태와 영속성

Files: src/scrape/naverSearchGuard.js, src/scrape/health.js, src/keyword/trends.js, scripts/doctor.js, electron/main.js의 초기화 연결, 새 persistence 모듈이 필요하면 src/scrape/ 아래, scripts/tests/의 관련 새 테스트.

- [x] 기존 의존성 설치 및 baseline tests/check. 실패를 구분하고 수정 범위에 필요한 환경 문제만 해결.
- [x] 원인별 실패 분류, 정상 0건, 독립 소스 진단, 손상 파일/TTL/재시작 fixture 테스트 작성 후 RED 확인.
- [x] 오류 메타데이터 전파, 안전한 디스크 캐시/제한 상태 연결, 실패 캐시 방지, 소스별 doctor 실행 구현.
- [x] 새 tests와 기존 serp-performance tests GREEN 확인. 운영 로그는 공개 URL와 상태만.

## Task 2 — 카드 파싱·출처 연결

Files: src/scrape/markup.js 또는 src/scrape/ 아래 전용 파서, src/keyword/trends.js, src/keyword/serpObserve.js, 관련 생성 프롬프트 전달 경로 및 scripts/tests/fixtures와 regression tests.

- [x] 요약 누락/다른 섹션/광고/위장 도메인/중복/게시일 없음 fixture tests RED 확인.
- [x] 카드 단위 title/snippet/url/sourceKind/collectedAt/contentKind 추출. 기존 반환과 호환하되 검증 불가 텍스트는 verified 근거로 집계하지 않음.
- [x] 뉴스·블로그 구분 및 모델에 전달되는 근거 출처 연결. 최신 관찰 HTML이 필요하면 제한 없는 한 번의 요청으로 로컬 fixture를 만들고 민감정보는 포함하지 않음.
- [x] 정상 자료·실제 0건·파서 불일치 구분 GREEN 확인. 의도 보정용 단순 text parsing과 verified 근거 parsing을 구분.

## Task 3 — 원문 근거와 검색용 보류 판정

Files: src/generator/searchBrief.js, generateSearchPost.js, buildSearchPrompt.js 필요 부분, electron/main.js 공식 자료 수집 경로, 관련 tests.

- [x] 제한+사용자 원문, 제한+기관 원문, 링크만 있음, 요약만 있음, 최신 기사 없음, 경험 없음 fixture tests RED 확인.
- [x] 검색 제한을 경고와 근거 부족으로 분리. strictEvidence는 필요한 근거가 없을 때 호출 전에 중단.
- [x] 요약/AI 브리핑만으로 공식 원문 인정하지 않도록 수정. 기관 URL의 hostname과 비어 있지 않은 본문 검증.
- [x] 전체 검색 원고 tests GREEN 확인. 상태와 경고의 한글 문구를 구분.

## Task 4 — Electron 렌더 준비와 Playwright 검증

Files: electron/main.js 최소 연결, 필요 시 electron/ 전용 rendered collector 모듈, package.json/lockfile, scripts/tests/ 및 로컬 fixture 전용 browser smoke entry.

- [x] 고정 대기·로드 오류 성공 처리 regression tests RED 확인.
- [x] 명시적 준비 조건과 제한 시간, 반환 상태·차단 검사·추출 실패 처리. 정상 HTTP/파싱 미지원 경우만 렌더 경로 허용하고 차단 때는 중단.
- [x] Playwright 개발 도구로 격리된 Electron fixture tests. 성공·지연 렌더·로드 실패·차단·누락 카드 확인. 필요한 Electron 바이너리는 기존 의존성 사용.
- [x] 실제 앱 smoke는 인증이나 임시저장 실행 없이 격리 프로필로만 가능. 실행 불가 시 정확한 환경 원인과 이미 실행한 대체 검증 기록.

## Task 5 — 미측정 경쟁도와 최종 확인

Files: src/keyword/competition.js와 실제 사용처, 관련 tests.

- [x] 실패·날짜 부족이 점수로 둔갑하지 않는 test RED 확인.
- [x] measured=false, null 점수, reason 반환 및 null-safe 사용처 수정.
- [x] npm run check, 전체 node tests, 새 Playwright smoke 순차 실행. live doctor는 차단 상태를 무시하거나 대량 검색하지 않고 한 번만 실행.
- [x] 변경 파일, 명령과 결과, 남은 제약을 보고. 부모가 STATUS/README를 최종 검증 결과에 맞게 갱신하고 diff review.

## 진행 기록

- 시작: 기존 소스 clean, 브랜치 fix/evidence-collection-reliability.
- Ruling: 작업은 이 전용 clone에서 별도 브랜치로 진행 — 상위 작업 폴더는 Git 저장소가 아니며 사용자 변경 없음 — 새 worktree 등록 불일치 없이 다운로드 위치에서 결과 검토 가능.
- Ruling: 사용자 요청으로 모델과 구현 진행이 명시됨 — 반복 승인 요청 없이 상세 명세와 구현을 진행.
- 코드 구현 상태: Luna/max 구현 및 통합 검증 완료. 실제 로그인 생성·임시저장은 미검증이며 다음 단계다.
- Baseline: Luna 구현 작업자가 기존 node:test 37개와 npm run check 통과를 확인했다.
- Ruling: 경쟁도 수정은 별도 Luna/max 작업자로 분리 — 수집/생성 경로와 파일이 겹치지 않는 독립 작업 — 경쟁도 작업자는 competition.js, score.js, niche.js, seedRadar.js, competition-measurement.test.js만 수정한다. 코어 작업자는 Tasks 1~4를 담당한다. 최종 전체 검증과 리뷰는 합쳐서 진행한다.
- Ruling: Task3 근거 판정/프롬프트/사실 대조는 세 번째 Luna/max 작업자로 분리 — 정책 테스트는 네트워크·브라우저 없이 독립 실행 가능 — 코어는 Tasks1/2/4를 담당하고 string[] 호환 결과의 sources와 gatherKeywordContext.keywordSources를 정책 작업자에게 연결한다. 파일 소유권 중복은 허용하지 않는다.
- Task1 RED: scripts/tests/evidence-collection.test.js에서 429 분류, 재시작 유예/캐시, 실패 캐시 방지, 진단 메타데이터, 독립 소스 진단의 기존 동작 실패를 확인했다. 아직 GREEN 결과는 기록하지 않는다.
- Task5 경쟁도 완료: competition-measurement.test.js 11개 통과. 부모가 같은 명령을 재실행해 확인. 실측 날짜 부족·응답 구조 실패·HTTP/통신 실패는 measured=false/gap=null이며, 호출자와 점수 구성도 미측정을 유지한다. git diff --check 통과. 전체 통합 검증은 나머지 구현 후 실행한다.
- Task1 GREEN: 부모가 node --test scripts/tests/evidence-collection.test.js를 실행해 8/8 통과 확인. 403/429 유예와 압축 캐시의 프로세스 재시작·만료·손상 항목 격리 및 독립 소스 진단을 검증했다.
- Ruling: Task4 렌더 수집·Playwright 검증도 별도 Luna/max 작업자로 분리 — 코어 파일 수정 대기 시간을 줄이기 위해 렌더 모듈·테스트·패키지 변경만 분리 — main.js의 scrapeRendered 래퍼만 브라우저 작업자 소유, guard 초기화·검색 수집 호출부는 코어 소유다. 최종 통합 리뷰 필수.
- Task3 구현 완료: 명시적인 요약 메타데이터는 기관·사용자 원문으로 승격하지 않고, 생성 원문을 사실 대조에 전달한다. 홈판 생성의 기사 sources 호환성과 생성 시작 시 초기화되는 기관 수집 오류를 보완했다. 작업자 정책 11/11, 검색 기준 9/9, SERP 13/13 통과 보고. 부모의 최종 전체 검증에 포함한다.
- 통합 검토: 부모가 캐시 원래 수집 시각, 렌더 제한 예외의 디스크 유예, 진단기의 SERP 객체 건수, 기사 종류별 본문 주소 일치를 추가 확인했다. 독립 Luna/max 검토자는 무관한 섹션의 빈 결과 문구가 파서 오류를 숨기는 사례를 재현했고 코어 작업자에게 회귀 수정으로 전달했다.
- Playwright 검토: 작업자는 로컬 8개 통과를 보고했지만 부모 재실행에서 시작 시간초과와 임시 프로필 정리 실패가 재현됐다. 사용자 세션에는 접근하지 않았으며, 실행 옵션과 시작·종료 제한 시간을 보완하고 부모가 최종 재검증한다. 중간 통과 보고만으로 완료 처리하지 않는다.

- 최종 검증: 부모가 마지막 변경 뒤 npm test 89/89, npm run check, git diff --check, 새 모듈 node --check를 통과했다. npm run test:rendered-browser는 실제 격리 Electron 8/8 통과 및 종료 코드 0이었다. 공개 doctor는 한 번만 실행했고, SERP 진단 수정 뒤 저장 캐시로 네트워크 없이 12건·OK를 확인했다. 개별 기사 실패의 HTTP 세부 진단과 실제 사용자 로그인·임시저장은 남은 경계로 문서화했다.
