# 발급 링크 원클릭 자동 진행 구현 계획

Spec: docs/superpowers/specs/2026-10-08-issued-link-autopilot-design.md
실행: 작업자는 anthropic/claude-sonnet-5 서브에이전트. 계획·결정·통합 검토는 Opus(부모). 작업자는 commit/push 금지, 다른 작업자 파일 수정 금지.
작업 폴더: C:/Users/user/Desktop/컨텐츠 생산/autosaas (원본 폴더에서 직접 작업, 파일 소유권으로 충돌 방지)

## Task A — 해석 경로(chain) 반환
Files: electron/shortlinkResolver.js, src/connect/productImport.js, scripts/tests/connect-product-import.test.js, scripts/tests/fixtures/shortlink-resolver-electron/main.js, scripts/tests/shortlink-resolver-electron.test.js
- 해석기가 did-navigate/did-navigate-in-page로 방문 주소를 기록해 { finalUrl, chain } 반환(chain[0]=입력, 중복 연속 제거).
- 수입기는 문자열/객체 반환 모두 지원, imported.resolution={issuedUrl, finalUrl, chain}.
- 테스트: 객체·문자열 반환, chain 전달, Electron fixture가 chain에 /bridge 포함 확인.

## Task B — 순수 자동 파이프라인
Files: src/connect/autoPipeline.js(신규), scripts/tests/connect-auto-pipeline.test.js(신규)
- Spec 계약 그대로 구현. src/topics/travelConnect.js의 buildTravelProductImportPayload와 src/connect/products.js normalizeConnectProduct를 사용해 결과가 실제로 verified 판정되는지 테스트.
- 테스트 fixture: scripts/tests/fixtures/travel-product-import/naver-ybtour-product.html을 extractTravelProduct로 읽어 실제 형태 사용. chain 없음/브랜드커넥트 없음 → not_issued_link, 옵션 없음 → no_price, 기존 상품 갱신·id 재사용, 씨앗 키워드, 신선도 판정.

## Task C — IPC 연결
Files: src/connect/service.js, electron/main.js, electron/preload.js, scripts/tests/connect-ipc.test.js
- service: 스키마 'connect:autoImport' ['url'](validateTravelProductUrl), 'connect:refreshProduct' ['productId'](문자열 1..80). 주입 의존성 autoImport({url}), 메서드 autoImport/refreshProduct. refreshProduct는 카탈로그에서 상품을 찾아 affiliateUrlRaw로 autoImport.
- main: autoImport = importer → autoPipeline.buildAutoImportSave → writeCatalog(기존 saveProduct 경로 재사용) → seeds. stage별 오류. 신뢰 발신자 검사 기존과 동일.
- preload: connectAutoImport, connectRefreshProduct.
- 테스트: 스키마 거부/허용, 신뢰 발신자, 서비스 위임, refresh가 저장된 링크 사용.

## Task D — UI
Files: app/travel-connect.html, app/travel-connect.js, app/travel-connect.css, scripts/tests/autopilot-ui-electron.test.js(신규, profile-form-electron.test.js 패턴, fixture는 page.evaluate로 api 함수 주입)
- Spec UI 흐름. api.connectAutoImport → 씨앗별 api.connectPrepareKeywords({seed, productIds:[id], questions:[], importXlsx:false}) 순차 → 병합(키워드 기준, fit 우선, 첫 등장 순서) → 키워드 버튼 → needsRefresh면 api.connectRefreshProduct → controller.generate({profileKey, keyword, productIds, variantIds, experience:'', travelTopic: 기존 select 값}).
- 진행/오류 메시지 텍스트로 표시(innerHTML 사용 시 esc), 중복 실행 방지, 실패 후 재시도 가능.
- 신선도는 UI에서 variant.priceCheckedAt 기준 6시간(자체 계산).
- 테스트: 성공 흐름(키워드 클릭 → generate 호출 인자), 발급 링크 아님 오류, 키워드 수집 실패 후 재시도.

## Task E — 통합 검증(부모)
npm test, npm run check, git diff --check, 실제 naver.me 링크로 Electron autoImport 1회, 문서(STATUS/README) 갱신, 앱 재실행.

## 재개 시 실행 기록

초기 Sonnet 작업자 일부가 429 제한으로 중단되어 남은 화면 구현·집중 검증을 GPT-6 Luna 작업자에게 인계했다. Opus 독립 검토 재요청도 429로 실행되지 않았다. 기존 설계를 유지하고 부모가 저장·출처·경로 일치·가격 시각을 검증했다. 서버 자동 확인은 발급 링크 경로를 확인하는 것으로 제한하며 예약 가능 여부를 뜻하지 않는다. 현재 작업 폴더에 직접 반영하며 이 작업에서 commit/push는 하지 않는다.
