@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================
echo  blog-auto 설치 + 검증
echo ==========================================
echo.

REM ---- 1) Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js 가 없습니다.
  echo     https://nodejs.org 에서 LTS 버전을 설치한 뒤, 이 창을 닫고 다시 실행하세요.
  goto :fail
)
for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo [OK] Node.js %NODEV%

REM ---- 2) Git for Windows (claude.exe 가 bash 필요)
set GITBASH=
if exist "%ProgramFiles%\Git\bin\bash.exe" set GITBASH=%ProgramFiles%\Git\bin\bash.exe
if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set GITBASH=%ProgramFiles(x86)%\Git\bin\bash.exe
if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set GITBASH=%LocalAppData%\Programs\Git\bin\bash.exe
if "%GITBASH%"=="" (
  where git >nul 2>nul
  if errorlevel 1 (
    echo [X] Git for Windows 가 없습니다. 클로드 실행기가 bash 를 필요로 합니다.
    echo     https://git-scm.com/download/win 에서 설치한 뒤, 이 창을 닫고 다시 실행하세요.
    goto :fail
  )
  echo [!] git 은 있으나 bash.exe 위치를 못 찾았습니다. 문제가 생기면 INSTALL.md 7번을 보세요.
) else (
  echo [OK] Git Bash: %GITBASH%
)

REM ---- 3) npm install
echo.
if exist node_modules\electron\dist\electron.exe (
  echo [OK] node_modules 이미 있음 - 설치 건너뜀 ^(다시 설치하려면 node_modules 폴더를 지우고 실행^)
) else (
  echo [..] 의존성 설치 중 ^(Electron + 클로드 SDK, 수 분 소요^)...
  call npm install
  if errorlevel 1 (
    echo [X] npm install 실패. 인터넷 연결을 확인하세요.
    goto :fail
  )
  if not exist node_modules\electron\dist\electron.exe (
    echo [..] Electron 바이너리 마무리 다운로드...
    node node_modules\electron\install.js
  )
  echo [OK] 설치 완료
)

REM ---- 4) 코드 무결성
echo.
echo [..] 코드 무결성 검사...
call npm run check --silent
if errorlevel 1 (
  echo [X] 코드 검사 실패 - 파일이 온전히 복사됐는지 확인하세요.
  goto :fail
)

REM ---- 5) 수집 라이브 테스트
echo.
echo [..] 수집 소스 라이브 테스트 ^(인터넷 필요^)...
call npm run doctor --silent
if errorlevel 1 (
  echo [!] 일부 수집 소스가 깨져 있습니다. 앱은 실행되지만 근거가 부족할 수 있습니다. ^(위 표의 "고칠 곳" 참조^)
)

echo.
echo ==========================================
echo  준비 끝. 실행:  npm start
echo  첫 화면에서 클로드 - 네이버 순서로 로그인하세요.
echo ==========================================
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
