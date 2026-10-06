# blog-auto

네이버 블로그 글을 Claude(구독 OAuth)로 자동 생성해 스마트에디터에 채워 넣는 Electron 앱.
홈판용 · 검색용 · 예약 자동 생성을 제한 없이 사용한다.

## 실행

```bash
npm install          # Electron 43 + @anthropic-ai/claude-agent-sdk (claude.exe 동봉)
npm start            # 앱 실행 → 로그인 화면(클로드 · 네이버 2단계)
npm run dev          # DevTools 열고 실행
npm run check        # 정적 일관성 검사 (IPC 채널 · window.api · 문법)
npm test             # 네트워크·글쓰기 모델 호출 없이 회귀 검사
npm run test:rendered-browser # 격리된 로컬 Electron/Playwright 검증
```

윈도우에서 `claude.exe`는 Git Bash가 필요하다. 시스템에 Git이 설치돼 있으면 자동으로 찾고, 없으면
`CLAUDE_CODE_GIT_BASH_PATH` 환경변수로 `bash.exe` 경로를 지정한다.

## 키워드 조사 보고서

네이버 검색광고에서 **도구 → 키워드도구 → 기준어 검색 → 전체 다운로드(.xlsx)** 순서로 원본을 내려받는다. 앱 로그인 화면에서 **로그인 없이 키워드 조사**를 누르거나, 메인 화면 상단의 **키워드 조사** 버튼을 누른다. 씨앗 키워드와 30·50·100개 선택, 제외어(쉼표 구분)를 입력한 뒤 내려받은 `.xlsx` 파일을 선택한다. 앱은 XLSX의 연관 키워드와 공개 네이버 자동완성 후보를 합쳐 미리보기를 만든다. Claude·네이버 로그인이나 API 키는 필요하지 않다.

미리보기의 PC·모바일 월간 검색수는 가져온 XLSX 값이다. `<10`은 원본대로 표시하며, PC와 모바일이 모두 숫자일 때만 합계를 계산한다. 자동완성 후보만 있는 키워드에는 검색량을 채워 넣지 않는다. **가져온 날짜**는 파일을 앱에서 읽은 날짜(한국 시간)이고, XLSX에 없는 실제 검색량 집계 기간으로 해석하면 안 된다. 분류와 검색 의도는 문구 기반의 편집용 규칙 추정이며, 실제 이용자 의도·SEO 난이도·검색 순위를 검증하지 않는다.

사주 씨앗에서는 사주·명리와 궁합·운세 일부 인접어를 주제 규칙으로 분류한다. 다른 일반 씨앗은 키워드 문구에 씨앗이 직접 포함된 항목만 자동 선정한다. 의미가 비슷하지만 씨앗 문구가 없는 후보는 자동으로 관련 있다고 판단하지 않으므로 결과가 요청 수보다 적을 수 있다. 부족한 수를 임의 후보로 채우지 않는다. 이름이나 상품명처럼 모호한 후보는 제외어에 직접 입력한다.

터미널에서는 같은 처리 로직을 다음처럼 사용할 수 있다. `--ads`는 생략할 수 있지만, 이 경우 검색량은 제공되지 않는다.

```bash
node scripts/keyword-report.js --seed "사주" --count 100 --ads "C:\Users\you\Downloads\keywords.xlsx" --out "outputs\saju-keywords.xlsx" --exclude "타로, 사주카드"
```

키워드 보고서와 IPC 입력 검증은 다음 테스트 두 파일로 실행한다. 앱 전체 정적 검사까지 함께 확인하려면 `npm run check`도 실행한다.

```bash
node --test scripts/tests/keyword-report.test.js scripts/tests/keyword-report-ui.test.js
npm run check
```

## 검색용 원고 기준과 성과 추적

검색용 생성은 키워드 의도를 분류하고 필수 답변과 근거를 점검해, 발행 준비·검수 필요·발행 보류 상태를 표시한다. 검색 결과 관찰로 불명확한 의도를 보정하고 발행 글의 순위를 추적한다. 구현 범위와 검증 상태는 [프로젝트 상태](docs/STATUS.md), 기준 문서는 [docs/search/](docs/search/)에서 확인할 수 있다.

## 구조

```
electron/main.js      메인 프로세스 — IPC 핸들러(키워드·생성·이미지·에디터 주입·예약·세션)
electron/preload.js   렌더러 브릿지 (window.api.*)
electron/siteCapture.js 주제별 사이트 화면 캡처 (세션·대기·저장 경로 주입 가능)
app/login.html        클로드(OAuth 코드) · 네이버(웹뷰) 로그인
app/app.html          메인 UI — 홈판용 / 검색용 탭 · 예약 패널 · 에디터 웹뷰
src/generator/        글 생성 (runClaude · buildPrompt · generatePost · generateSearchPost · searchBrief · searchContentCheck)
src/keyword/          키워드·근거 수집 (trends · advisor · expand · niche · background · radar · report · serpObserve …)
src/performance/      검색용 원고 발행·순위 성과 추적
src/scrape/naverSearchGuard.js 네이버 검색 요청 직렬화·차단 보호
src/topics/           주제 설정·프로필·검색 키워드·원고 맥락·사진 자산
src/image/            뉴스 사진 수집(newsImages) · Claude 비전 필터(visionFilter)
src/thumbnail/        텍스트 카드 썸네일 SVG → PNG
src/place/            네이버 플레이스 장소 조회
docs/                 프로젝트 상태와 검색용 기준 문서
scripts/check.js      정적 일관성 검사
```

## 로컬 데이터 위치

`%APPDATA%/blog-auto/` — 네이버 세션(persist:naver) · 예약 설정 · 프로필 · 토큰 사용 로그 · 진단 덤프.
클로드 인증은 `~/.claude/` (claude CLI 표준 경로).

## 유지보수 — 수집이 깨졌을 때

검색 수집은 공식 검색 API를 사용하지 않는다. `src/scrape/markup.js`에서 카드별 제목·요약·URL을 읽고, 제한·HTTP 오류·시간초과·지원하지 않는 구조와 정상 빈 결과를 구분한다. 공개 검색 캐시와 제한 유예는 사용자 데이터 폴더의 `search-state.json`에 저장한다. CLI 저장 위치는 `NAVER_AUTO_CACHE_DIR`로 지정할 수 있다.

`npm run doctor`는 실제 공개 사이트에 접속하는 진단이다. 403·429가 확인되면 검색 요청을 중단하고 독립 소스만 계속 검사한다. 결과 건수는 원문 품질이나 실제 생성·임시저장 성공을 보장하지 않는다. 수정 이유는 [기술 결정](docs/EVIDENCE_DECISIONS.md), 검증 범위는 [검증 문서](docs/EVIDENCE_VALIDATION.md)를 참고한다.

```bash
npm run doctor        # 실제로 한 번씩 수집해보고 어느 소스가 깨졌는지 표로 출력
```

- `src/scrape/markup.js` — 셀렉터·정규식·페이지 추출 스크립트 (깨지면 여기만 고친다)
- `src/scrape/health.js` — 수집 건수 기록 → 생성 결과에 경고로 실림
- 앱 화면: 생성이 끝나면 상태줄 아래에 **자료 수집 문제**와 **사실 확인이 필요한 부분**이 뜬다
- `%APPDATA%/blog-auto/factcheck.log` — 팩트 대조 지적 누적 기록

브라우저 렌더가 필요한 소스(연예·스포츠 랭킹, 구글 트렌드, 어드바이저)는 doctor 대상이 아니다 —
앱 실행 로그(`[entSp] 0건 …`)와 생성 후 경고로 확인한다.

## 원고의 근거

| 재료 | 출처 | 홈판용 | 검색용 |
|---|---|:-:|:-:|
| 기사 **본문** | 공개 기사 페이지·기존 웹페이지용 본문 응답 | ✅ | ✅ |
| 뉴스 제목+요약 | 뉴스 검색(최신순) | ✅ | ✅ |
| 인물 배경 | 나무위키(동명이인은 최신뉴스로 판별) | ✅ | ✅ |
| 블로그 후기·정보 | 블로그 검색 스니펫 | ✅ | ✅ |
| 장소 실데이터 | 네이버 플레이스(코드가 직접 조립, LLM 미경유) | ✅ | ✅ |
| 공식 기관 본문 | AI브리핑 인용 사이트 | — | ✅ |

생성이 끝나면 **팩트 대조**(haiku)가 본문의 날짜·수치·고유명사·발언을 출처가 확인된 원문과 대조한다. 검색 요약과 후기 발췌는 참고 자료로 구분한다. 검색용 원고는 근거 부족과 고위험 사실 지적 등을 반영해 발행 준비·검수 필요·발행 보류로 표시하며, 예약 경로는 보류 원고를 저장하지 않는다. 최종 내용의 정확성은 사람이 검수한다.
