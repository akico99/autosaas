# 여행 상품 URL 자동 등록 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 사용자 지정 실행 방식은 Luna / max 서브에이전트이며 추가 실행 승인 없이 진행한다.

**Goal:** 상품 URL만으로 등록 정보와 근거를 채우고 사용자는 옵션·누락·확인만 처리한다.
**Architecture:** 독립 상품 parser/collector를 기존 connect service/IPC에 주입한다. 등록 화면은 import 결과를 검수 가능한 제안으로 표시하고 기존 저장·검수·보관 경로를 재사용한다.
**Tech Stack:** CommonJS, Cheerio, Electron, node:test, 기존 Playwright.
**Spec:** docs/superpowers/specs/2026-10-08-travel-product-import-design.md

## Global Constraints

- 공식 API·실제 모델 호출 금지. 현재 Node/Electron/의존성 유지.
- 개발 코드 수정은 GPT-6 Luna / max 서브에이전트. 원격 push 금지.
- 자동 수집과 사람 검토 구분, 제휴 링크 원문 보존, 옵션별 가격·근거 유지.
- 기존 원고·상품·로그인 상태·실행 중 앱 보존. 저장/발행 외부 작업 실행 금지.

## Review Focus

- 여러 JSON-LD 상품·추천 상품·다중 옵션의 가격이 혼입되지 않는가.
- AggregateOffer·최저가·외화·상충 가격을 확정 가격으로 만들지 않는가.
- 수집 실패/느린 응답/URL 변경이 입력을 덮어쓰거나 버튼을 잠그지 않는가.
- 가져온 원문·수집 시각·옵션 사실이 저장까지 남고 미검토 상태가 유지되는가.
- URL/리디렉션으로 로컬 자원에 접근하거나 renderer가 맥락을 주입하지 못하는가.

## Task 1: 상품 추출·수집과 IPC — backend worker

**Files:** Create src/connect/productImport.js, 필요한 집중된 helper; Modify src/connect/service.js, electron/main.js, electron/preload.js; Test scripts/tests/connect-product-import.test.js, 기존 IPC/startup 테스트.
**Interfaces:** Spec의 extractTravelProduct/createTravelProductImporter, connect:importProduct, connectImportProduct, imported 계약을 그대로 제공한다. UI 소유 파일을 수정하지 않는다.

- [x] 테스트 먼저: Product/Offer fixture에서 name, KRW 가격, 출처 URL/시각/발췌가 일치하고 facts는 미검토; 다중 옵션 가격 연결; 범위·외화·충돌·추천 상품·미상은 경고/비움.
- [x] 수집·IPC 실패 테스트: public URL 제한/리디렉션, 차단/HTTP/시간초과, trusted sender, 알 수 없는 입력 키, 캐시 자료의 원래 수집 시각.
- [x] 집중 parser/collector 구현과 기존 서비스 주입, main/preload 연결. 추가 의존성 없이 구현했다.
- [x] parser/IPC/startup 집중 테스트와 `npm run check` 통과. 실제 모델/외부 계정 호출 없음.
- [x] 변경 경로·정확한 계약·결과·한계를 보고했다. worker는 commit/push하지 않았다.

## Task 2: 자동채움·옵션 검수·저장 UI — UI worker (Task 1과 계약을 고정해 병렬)

**Files:** Modify app/travel-connect.html, app/travel-connect.css, app/travel-connect.js, 필요한 src/topics/travelConnect.js helper; Test scripts/tests/connect-product-import-ui.test.js, scripts/tests/connect-ui-electron.js, scripts/tests/fixtures/connect-ui.html.
**Interfaces:** await api.connectImportProduct({url}) → imported 계약. existing api.connectSaveProduct({product,sources}) 저장. backend 소유 파일을 수정하지 않는다.

- [x] 가짜 API 테스트: 상품 정보·근거·시각, 옵션 선택 및 가격 분리, facts 상태, 실패·늦은 응답·URL 불일치 보호.
- [x] URL 중심 첫 화면과 진행/경고/누락/원문 확인, 상세 보완 입력을 연결했다. 원문 발췌 재입력을 없애고 미상값만 보완한다.
- [x] 수동 등록·기존 수정/다른 옵션·발급 링크·검수 동작을 유지하고, 페이지 HTML은 텍스트로 표시한다.
- [x] 화면 경계·스크롤과 로컬 fixture를 검증했다.
- [x] 집중 UI 테스트 및 원본 앱 Electron 스모크를 통과했고 결과를 보고했다. worker commit/push는 하지 않았다.

수동 보완 저장 시 가져온 수집 시각을 우선하는 처리의 집중 테스트와 Electron 화면 검사가 통과했다.

## Task 3: 독립 검토·통합 검증·원래 앱 폴더 반영 — parent와 reviewer

- [x] 부모가 계약·연결·검증 증거를 검토했다.
- [x] 별도 Luna/max reviewer가 자료 혼입·가격·URL·검토 승격·저장·UI 경쟁조건을 검토했다.
- [x] 발견 결함을 해당 worker가 수정하고 관련 테스트를 재실행했다. JSON-LD URL 선택과 본문 스크립트 보존 회귀를 포함한다.
- [x] 원래 앱 폴더에서 `npm test` 246/246, `npm run check`, `git diff --check`, URL guard·수동 흐름을 포함한 최종 Electron 스모크(exit 0)를 확인했다. 렌더링 브라우저 8/8도 기록됐다.
- [x] STATUS/README/설계·검증 문서를 갱신했다. fixture 검증 범위와 실제 공개 URL 확인을 구분했다.
- [x] 21개 파일을 원래 autosaas 작업 폴더에 적용하고 파일 해시를 확인했다. 원격 commit/push는 하지 않았다.
