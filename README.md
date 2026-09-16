# blog-auto

네이버 블로그 글을 Claude(구독 OAuth)로 자동 생성해 스마트에디터에 채워 넣는 Electron 앱.
홈판용 · 검색용 · 예약 자동 생성 전부 **등급 제한 없이** 사용한다.

## 실행

```bash
npm install          # Electron 43 + @anthropic-ai/claude-agent-sdk (claude.exe 동봉)
npm start            # 앱 실행 → 로그인 화면(클로드 · 네이버 2단계)
npm run dev          # DevTools 열고 실행
npm run check        # 정적 일관성 검사 (IPC 채널 · window.api · 문법 · 등급 잔재)
```

윈도우에서 `claude.exe`는 Git Bash가 필요하다. 시스템에 Git이 설치돼 있으면 자동으로 찾고, 없으면
`CLAUDE_CODE_GIT_BASH_PATH` 환경변수로 `bash.exe` 경로를 지정한다.

## 구조

```
electron/main.js      메인 프로세스 — IPC 핸들러(키워드·생성·이미지·에디터 주입·예약·세션)
electron/preload.js   렌더러 브릿지 (window.api.*)
app/login.html        클로드(OAuth 코드) · 네이버(웹뷰) 로그인
app/app.html          메인 UI — 홈판용 / 검색용 탭 · 예약 패널 · 에디터 웹뷰
src/generator/        글 생성 (runClaude · buildPrompt · generatePost · generateSearchPost · postTypes)
src/keyword/          키워드·근거 수집 (trends · advisor · expand · niche · background · radar …)
src/image/            뉴스 사진 수집(newsImages) · Claude 비전 필터(visionFilter)
src/thumbnail/        텍스트 카드 썸네일 SVG → PNG
src/place/            네이버 플레이스 장소 조회
scripts/check.js      정적 일관성 검사
```

## 원본 대비 변경 (포크 정리)

- 아백(aros100.com) 로그인 · 마이페이지 스크랩 · 등급(free/allinone/booster) 판정 · 잠금 UI · 부스터 키워드 제거
- 로그인 3단계 → 2단계 (클로드 · 네이버)
- 생성 대기 화면의 유튜브 재생목록 제거
- `toSmartEditor.js`(미완·미사용) · `mockups/` · `docs/` · `index.html`(시안 허브) 제거
- userData 폴더 `naver-blog-auto` → `blog-auto`, 스케줄러 작업명 `AbaekBlogAutoPost` → `BlogAutoPost`
- 그 외 수집·생성·검증·이미지·썸네일·에디터 주입·예약 로직은 원본 그대로

## 로컬 데이터 위치

`%APPDATA%/blog-auto/` — 네이버 세션(persist:naver) · 예약 설정 · 프로필 · 토큰 사용 로그 · 진단 덤프.
클로드 인증은 `~/.claude/` (claude CLI 표준 경로).

## 유지보수 — 수집이 깨졌을 때

네이버가 페이지 구조를 바꾸면 수집 함수가 **에러 없이 0건**이 된다(전부 `catch → []`).
그래서 마크업 의존부는 전부 `src/scrape/markup.js` 한 곳에 모아두고, 건수를 기록해 표면화한다.

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
| 기사 **본문** | 네이버 뉴스 API·모바일 본문 | ✅ | ✅ |
| 뉴스 제목+요약 | 뉴스 검색(최신순) | ✅ | ✅ |
| 인물 배경 | 나무위키(동명이인은 최신뉴스로 판별) | ✅ | ✅ |
| 블로그 후기·정보 | 블로그 검색 스니펫 | ✅ | ✅ |
| 장소 실데이터 | 네이버 플레이스(코드가 직접 조립, LLM 미경유) | ✅ | ✅ |
| 공식 기관 본문 | AI브리핑 인용 사이트 | — | ✅ |

생성이 끝나면 **팩트 대조**(haiku)가 본문의 날짜·수치·고유명사·발언을 위 근거와 대조해
근거에 없는 것을 골라낸다. 차단이 아니라 경고다 — 널리 알려진 상식일 수도 있으므로 판단은 사람이 한다.
