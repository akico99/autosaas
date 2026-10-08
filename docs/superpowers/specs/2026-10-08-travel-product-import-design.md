# 여행 상품 URL 자동 등록 설계

기준일: 2026-10-08. 기준 커밋: d3a6f1a. 사용자 요청: 상품 등록 수작업을 줄이는 방향으로 계획하고 서브에이전트가 구현·반영한다. 이번 요청 자체를 설계·계획·실행 방식의 승인으로 적용하며 단계별 재승인을 요구하지 않는다. 개발 구현과 수정은 GPT-6 Luna / max 작업자에게 맡긴다. 공식 API는 사용하지 않는다.

## 목표와 범위

상품 상세 URL 입력 → 공개 페이지 읽기 → 상품/옵션/근거 자동 채움 → 옵션 선택·누락/불확실 값 확인 → 기존 카탈로그 저장 → 기존 원고 생성. 수집 성공을 사실 검토 완료나 제휴 대상 확인으로 취급하지 않는다. 확인한 발급 링크는 별도 입력하며 원문을 보존한다.

수집과 파싱은 별개로 둔다. 수집기는 Node HTTP(S)로 공개 HTML을 요청하고 Cheerio로 정적 HTML을 파싱한다. 일반 페이지는 요청 URL과 일치하는 JSON-LD Product/Offer와 본문에 보이는 명시적 항목을 사용한다. Product에 URL이 있으면 요청 URL과 일치해야 하며, URL 없는 Product는 유일한 Product일 때만 허용한다. 본문에 포함된 JSON-LD도 파싱하며, 화면 발췌는 별도 DOM 복제본에서 만들어 스크립트를 제거해도 파싱 데이터는 보존한다. 네이버 패키지 상세는 `#__NEXT_DATA__`의 Apollo 상태에서 요청 URL과 정확히 일치하는 상품 ID 레코드를 선택하고, 연령별 임베디드 기본 요금은 본문에 같은 연령 라벨·금액 행이 보일 때만 옵션 가격으로 제안한다. 구조화 데이터나 명시적 페이지 내용이 없는 항목은 빈 값과 누락 경고로 둔다. 모델 호출, 공식 상품 API, 전체 상품 상시 수집, 로그인 세션 이용, 보안 절차 자동 해결, 이미지 권리 자동 승인은 범위 밖이다.

검증 대상 판매처 URL이 제공되어 구현 중 실제 공개 응답을 확인했다. 이 설계의 collector 결정은 아래 구현 상태를 반영하며, 초기 계획의 렌더 브라우저 수집 방식은 채택하지 않았다.

## 구현 계약

- IPC `connect:importProduct`는 `{url:string}`만 받는다. main의 기존 trusted sender 검사와 입력 스키마를 적용한다.
- preload `connectImportProduct(request)` → service `importProduct({url})`.
- 성공 `{ok:true, imported:{product, sources, fieldEvidence, missingFields, warnings, collectedAt}}`. product는 기존 여행 상품 키를 쓰는 등록 제안이다. 필수값 누락을 허용하는 제안이며 기존 normalizeConnectProduct를 거쳐 최종 저장한다. fieldEvidence는 `{field,value,sourceId,excerpt}` 항목이다. 상세·최종 출처 URL과 시각을 유지한다.
- 실패 `{ok:false,error,kind?}`. 수집 실패를 등록 0건 성공으로 표시하지 않는다. 기존 입력과 카탈로그는 유지한다.
- parser `extractTravelProduct({html,url,collectedAt})`는 네트워크 없는 함수다. `createTravelProductImporter({fetchHtml,now,...})`는 공개 URL을 검증하고 HTML을 받아 parser를 호출한다. 기본 `fetchHtml` 구현은 DNS를 조회해 모든 응답 IP가 공인 주소인지 검사하고 선택한 공인 IP에 연결을 고정해 DNS 재바인딩을 막는다. 요청마다 제한 시간·응답 크기를 적용하며 HTTP(S) 리디렉션은 따라가지 않고 거부한다.
- 상품명·제공사·목적지·유형·박/일·포함/불포함·취소조건은 원문이 있을 때만 채운다. 원문 기반으로 제안한 값은 사람이 고칠 수 있다. 미상은 빈 값과 경고로 표시한다.
- 가격은 KRW 원 단위만. Offer별 가격과 출발/인원/객실 조건을 연결한다. 다른 상품 추천 Offer, 외화 가격, 범위/최저가/AggregateOffer, 상충 가격을 특정 확정 옵션 가격으로 승격하지 않는다. 옵션마다 근거를 유지하며 없는 숫자를 0으로 채우지 않는다.
- 출처는 실제 읽은 페이지와 발췌다. 원문 발췌·가격 발췌·수집 시각을 자동 채워 동일 내용을 재입력할 필요를 없앤다. 자동 수집 facts는 unverified이며 사용자가 출처를 확인한 경우만 기존 검토 로직으로 승격한다. 제휴 대상은 unknown, 링크는 빈 값이 기본이다.
- 공개 http(s) URL만 허용한다. 자격증명 URL, 비표준 포트, localhost, 사설·루프백 대상과 리디렉션은 거부한다. DNS 결과를 공인 IP로 제한하고 요청을 해당 확인 IP에 고정하며 제한 시간·응답 바이트 상한을 적용한다. 403/429, 기타 HTTP 오류, 잘못된 콘텐츠, timeout, DNS 실패는 typed failure로 반환한다. 수집은 익명 HTTP 요청이며 Electron `BrowserWindow`, 격리 브라우저 세션, BrandConnect 로그인 세션, 렌더된 DOM 폴백을 사용하지 않으므로 생성·정리할 수집 창이 없다. 입력 페이지 내용은 코드 명령으로 취급하지 않는다.
- UI는 상품 추가의 첫 단계에 URL과 ‘정보 가져오기’를 표시한다. 가져온 상품·옵션 요약, 누락/불확실 표시, 원문 확인과 저장을 제공한다. 상세 수동 입력은 수정/보완 경로로 둔다. 진행 중 중복 요청·오래된 응답 적용을 막고 실패 시 버튼을 복구한다. 기존 입력/상품/다른 옵션/제휴 링크를 무단 덮어쓰지 않는다.

## 검증과 반영

합성 Product/Offer·한국어 DOM fixture와 실제 공개 네이버 패키지 응답 fixture를 사용해 상품 ID 일치, 연령별 fare와 DOM 행 대조, 쿠폰가 혼입 방지, 출처·수집 시각을 검사한다. DNS 공인 주소 검사, 사설 IP, URL 제한, 리디렉션, 차단·HTTP 실패·시간초과, 혼합 가격 및 부분 정보를 회귀 검사한다. UI 가져오기→자동채움→옵션 선택→확인→저장은 가짜 API로 검증한다. 인증 계정 동작·저장/발행과 실제 모델 호출은 하지 않는다. 공개 HTML의 당시 반환값을 확인하는 검증은 실제 URL로 별도로 수행한다.

구현 및 현재 한계:

- collector는 익명 HTTP(S) GET으로 서버가 전달한 HTML을 읽는다. 브라우저 실행 뒤 렌더되는 SPA 전용 정보는 읽지 못하므로 필드가 누락될 수 있다. 로그인·쿠키가 필요한 페이지와 BrandConnect 세션 DOM은 지원하지 않는다.
- Naver 패키지 가격은 Apollo embedded product record와 본문 연령별 가격 행이 일치하는 경우에만 가져온다. 쿠폰가와 포인트는 기본 옵션 가격이 아니며 별도 typed 상품 필드로 구조화하지 않는다. 정적 페이지 데이터가 오래되었거나 화면과 불일치할 때 예약 단계의 최종 결제액을 보장하지 않는다.
- 기존 상품의 상세 URL과 가져온 URL이 다르거나, 가져온 뒤 저장 폼의 상세 URL을 변경한 경우 UI helper가 저장을 거부한다. 같은 URL을 편집하는 경우 기존 제휴 링크를 유지한다.
- 구현 변경 21개 파일을 원래 앱 폴더에 적용했고 파일 해시를 대조했다. 원래 폴더의 `npm test` 245/245, `npm run check`, `git diff --check`, URL guard와 수동 흐름을 확인한 Electron 스모크(종료 코드 0)가 통과했다. 부모는 현재 원래 앱 창을 확인 중이다. 원격 commit/push는 하지 않았다.

구현은 `feat/travel-product-import` 격리 worktree에서 진행한 뒤 원래 앱 작업 폴더에 적용했다. 검토와 전달 상태는 [프로젝트 상태](../../STATUS.md) 및 [검증 기록](../../topics/travel-product-import-validation.md)에 정리했다.
