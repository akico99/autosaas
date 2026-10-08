# 발급 링크 원클릭 자동 진행 설계

기준일: 2026-10-08. 결정·계획: Opus. 단순 구현: 하위 모델(Sonnet) 서브에이전트. 공식 API·모델 호출 추가 없음.

## 목표

사용자는 브랜드커넥트 발급 링크(naver.me) 하나를 넣고, 추천 키워드 중 하나를 고른다. 그 사이의 상품 등록·근거 검토·옵션 선택·제휴 링크 등록·키워드 후보 수집은 앱이 처리한다. 키워드를 고르면 원고 생성과 보관함 저장까지 자동으로 이어진다. 네이버 에디터 삽입과 발행은 사용자 계정에 쓰는 동작이라 버튼 한 번으로 남긴다.

## 현재 막히는 지점

원고 생성 전 검사(travelCostGate)가 다음을 요구한다. 자동 진행은 각 조건을 코드가 검증할 수 있는 근거로 채운다.

| 조건 | 자동 충족 방법 |
| --- | --- |
| 제휴 대상(eligibility) 확인 | 발급 링크가 brandconnect.naver.com/connect/{id} 중계를 거쳐 pkgtour.naver.com 상품으로 이동한 경로를 출처로 기록 |
| 발급 제휴 링크 | 사용자가 넣은 naver.me 원문을 affiliateUrlRaw로 저장 |
| 가격 근거 검토 | 방금 수집한 공식 상품 페이지 전문에서 발췌·값 일치를 서버 검사(reviewFact)가 확인한 사실만 verified |
| 24시간 내 가격 확인 | 생성 직전 수집 시각이 6시간을 넘으면 같은 링크로 다시 수집 |
| 출발일 | 상품 페이지 출발일을 옵션에 저장 |

## 결정

D1. 자동 검토의 근거는 코드 검사다. 렌더러는 verified를 주장할 수 없다. 메인 프로세스가 수집 직후 sourceConfirmed=true, checkedAt=collectedAt으로 저장을 시도하고, 기존 normalize/reviewFact가 원문 전문에 발췌가 있고 발췌에 값이 있는 사실만 verified로 남긴다. 실패한 사실은 unverified로 남고 생성 보류 사유로 표시된다.

D2. eligibility=verified는 발급 링크 경로가 확인된 경우에만 둔다. 해석기가 이동 경로(chain)를 반환하고, 경로에 https://brandconnect.naver.com/connect/ 로 시작하는 주소와 최종 pkgtour.naver.com/products/ 주소가 모두 있어야 한다. 이 경로를 별도 출처(accessLevel full-page, excerpt = 경로 문자열)로 저장하고 eligibility 사실의 근거로 연결한다. 일반 상세 URL만 넣으면 자동 진행을 멈추고 "브랜드커넥트에서 발급한 링크를 넣어 주세요"를 표시한다. 기존 수동 등록 경로는 그대로 쓸 수 있다.

D3. 옵션은 같은 출발일의 연령별 기본가 옵션을 모두 선택한다. 쿠폰가·포인트는 기존처럼 옵션 가격에 넣지 않는다.

D4. 같은 detailUrl의 상품이 카탈로그에 있으면 그 상품을 갱신한다(기존 옵션·이미지 보존, 같은 조건 옵션은 id 재사용).

D5. 키워드 씨앗은 상품에서 만든다: 방문 도시(예: 대마도)로 "{도시} 여행", "{도시} 패키지", 출발 도시가 있으면 "{출발도시}출발 {도시}". 씨앗마다 기존 prepareKeywords를 순서대로 호출하고(검색 관찰 속도 제한 유지) 키워드 기준으로 병합한다. 검색광고 XLSX는 선택 사항으로 남긴다.

D6. 키워드를 고르면 현재 선택된 프로필로 기존 generate 경로를 호출한다. 결과는 기존 보관함 상태(준비됨/검수 필요/보류)와 사유를 그대로 보여 준다.

D7. 수집 실패·차단·발급 링크 아님·가격 없음은 단계별 메시지로 멈추고, 지금까지 저장된 상품은 유지한다.

## 계약

- 해석기: resolveUrl(url) → { finalUrl, chain: string[] } (chain은 방문한 주소 순서, 첫 원소는 입력 URL). 문자열 반환도 계속 허용(chain=[url, finalUrl]).
- 수입기: 단축 링크 해석 시 imported.resolution = { issuedUrl, finalUrl, chain }.
- src/connect/autoPipeline.js (순수 함수, electron 미사용)
  - isBrandConnectChain(chain) → boolean
  - buildAutoImportSave({ imported, catalog, now }) → { ok:true, product, sources, variantIds } | { ok:false, error, kind }
    - kind: 'not_issued_link' | 'no_price' | 'invalid'
    - existing = catalog.products에서 같은 detailUrl
    - travelConnect.buildTravelProductImportPayload(sourceConfirmed:true, checkedAt: imported.collectedAt, 모든 KRW 옵션 선택)
    - eligibility 출처(id: 'src_chain_' + sha256(chain).slice(0,12))와 사실 { field:'eligibility', value:'브랜드커넥트 발급 링크', sourceId, excerpt: chain.join(' → '), status:'verified', checkedAt: collectedAt }, product.eligibility='verified'
  - deriveSeedKeywords(product) → string[] (중복 제거, 최대 3개)
  - needsPriceRefresh(product, variantIds, now, maxAgeMs=6h) → boolean
- IPC connect:autoImport({ url }) → { ok, product, variantIds, seeds, warnings } 또는 { ok:false, error, kind, stage }
  - stage: 'resolve' | 'collect' | 'save'
- IPC connect:refreshProduct({ productId }) → 저장된 affiliateUrlRaw로 다시 autoImport 후 같은 응답.
- preload: connectAutoImport(req), connectRefreshProduct(req).

## UI

여행커넥트 상단에 "발급 링크로 자동 진행" 카드: 링크 입력 + 시작 버튼 → 진행 단계 표시(주소 확인 → 상품 수집 → 근거 검토·저장 → 키워드 후보) → 요약(상품명·출발일·연령별 가격·검토 실패 항목) → 추천 키워드 목록(적합 순 최대 10개, 검색량·관찰 근거 표시) → 키워드 버튼 클릭 시 가격 신선도 확인(필요 시 refresh) 후 생성 → 결과 상태와 "보관함에서 보기". 기존 상세 등록·키워드·생성 카드는 아래에 그대로 둔다.

## 범위 밖

에디터 자동 삽입·임시저장·발행, 이미지 자동 사용, 공식 API, 브랜드커넥트 로그인 세션 사용.
