# 다른 PC에 옮겨 설치하기

## 1. 먼저 설치할 것 (2개)

| 프로그램 | 왜 | 확인 명령 | 받는 곳 |
|---|---|---|---|
| **Node.js** 18.17 이상 (LTS 권장) | 앱 실행 엔진·카드 DOM 파서 | `node -v` | https://nodejs.org (LTS) |
| **Git for Windows** | 클로드 실행기(`claude.exe`)가 bash를 필요로 함. 없으면 로그인·글 생성이 죽음 | `git --version` | https://git-scm.com/download/win |

둘 다 설치 화면에서 **다음만 눌러 기본값으로** 설치하면 됩니다. 설치 후 **터미널(PowerShell)을 새로 열어야** 인식됩니다.

> Git 설치 시 "Adjusting your PATH" 단계는 기본값(Git from the command line and also from 3rd-party software)으로 두세요.

## 2. 폴더 복사

`blog-auto` 폴더를 새 PC 원하는 위치에 복사합니다. **`node_modules` 폴더는 빼고** 복사하세요(644MB, 플랫폼 종속 바이너리 포함).

이 zip 파일로 받았다면 이미 빠져 있습니다 — 그냥 압축을 풀면 됩니다.

## 3. 설치 + 검증 (한 번에)

폴더 안에서 `setup.cmd`를 **더블클릭**하거나, 폴더에서 PowerShell을 열고:

```powershell
.\setup.cmd
```

이 스크립트가 순서대로:
1. Node.js · Git 설치 여부 확인 (없으면 어디서 받을지 알려주고 멈춤)
2. `npm install` — Electron·클로드 SDK 다운로드 (수 분, 인터넷 필요)
3. `npm run check` — 코드 무결성 검사
4. `npm run doctor` — 실제 수집 7종 라이브 테스트

마지막에 `모든 소스 정상` 이 나오면 준비 끝입니다.

## 4. 실행

```powershell
npm start
```

## 5. 로그인 다시 하기 (필수)

인증 정보는 프로젝트 폴더에 **들어 있지 않습니다**(의도된 것 — 자격증명을 폴더에 두지 않음). 새 PC에서 2개 다시 로그인합니다.

| 무엇 | 저장 위치 | 하는 법 |
|---|---|---|
| 클로드 | `C:\Users\<사용자>\.claude\` | 앱 첫 화면 [클로드로 로그인] → 브라우저에서 승인 → 코드 붙여넣기 |
| 네이버 | `%APPDATA%\blog-auto\` | 앱 안 네이버 로그인 창에서 직접 |

이전 PC의 인증 파일을 복사해 옮기지 마세요. 새로 로그인하는 게 안전하고 확실합니다.

## 6. 옮겨가지 않는 것 (필요할 때만)

앱 데이터는 `%APPDATA%\blog-auto\` 에 있고 폴더 복사로는 안 옮겨집니다. 대부분은 새로 만들어도 되는 것들입니다.

| 파일 | 내용 | 옮길 필요 |
|---|---|---|
| `resv-settings.json`, `resv-settings-search.json` | 예약 설정 | ✗ — 예약은 Windows 작업 스케줄러에 PC별로 등록되므로 **새 PC에서 앱에서 다시 설정** |
| `profile.json` | 내 프로필(글쓴이 정보) | △ — 복사하면 다시 안 적어도 됨 |
| `recent-topics.json`, `search-recent.json` | 최근 쓴 키워드(중복 회피용) | △ — 복사하면 이전 소재를 계속 피함 |
| `token-usage.log`, `factcheck.log` | 사용 기록 | ✗ |
| 브라우저 캐시·세션 폴더들 | 네이버 로그인 상태 | ✗ — 다시 로그인 |

"유형·말투 고정" 같은 화면 설정은 브라우저 localStorage에 있어 옮겨지지 않습니다. 새 PC에서 다시 고르면 됩니다.

## 7. 문제가 생기면

| 증상 | 확인 |
|---|---|
| `node`를 찾을 수 없음 | Node.js 설치 후 터미널을 새로 열었는지 |
| 클로드 로그인/생성 실패, `bash` 관련 오류 | Git for Windows 설치 여부. 설치했는데도 그러면 환경변수 `CLAUDE_CODE_GIT_BASH_PATH` 에 `C:\Program Files\Git\bin\bash.exe` 지정 |
| `npm run doctor` 에서 FAIL | 인터넷 연결 확인. 연결이 되는데 FAIL이면 네이버 구조 변경 — `src/scrape/markup.js` (doctor 출력의 "고칠 곳" 참조) |
| 앱은 뜨는데 글 생성이 안 됨 | 앱 첫 화면에서 클로드가 "완료"인지. 아니면 `%APPDATA%\blog-auto\claude-debug.txt` 확인 |

## 요약

```
Node.js 설치 → Git 설치 → 폴더 복사(node_modules 제외) → setup.cmd → npm start → 클로드·네이버 로그인
```
