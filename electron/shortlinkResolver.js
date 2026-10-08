'use strict';

// 네이버 발급 단축 링크(naver.me)는 서버 307 리다이렉트 뒤에 클라이언트 자바스크립트로
// 상품 주소를 다시 계산하는 중계 페이지(brandconnect.naver.com)를 거친다. 순수 HTTP
// 리다이렉트 추적만으로는 최종 주소를 알 수 없어, 격리된 세션의 숨김 창에서 그 페이지를
// 그대로 열어 최종 URL이 안정될 때까지 관찰한다. 허용 목록 밖 호스트로 이동하면 즉시 중단한다.

const SHORTLINK_HOSTS = new Set(['naver.me']);
const DEFAULT_ALLOWED_NAVIGATION_HOSTS = /(^|\.)naver\.com$|(^|\.)naver\.me$|(^|\.)pstatic\.net$/i;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_NAVIGATIONS = 8;
const STABLE_POLL_MS = 250;
const STABLE_CHECKS_REQUIRED = 2;
// 중계 페이지(brandconnect.naver.com)는 로드 직후가 아니라 내부 API 조회 후 비동기로
// 최종 상품 주소로 이동한다. 로드 직후의 URL을 그대로 "안정됐다"고 판단하지 않도록
// 최소 대기 시간을 둔다. 실측(브랜드커넥트 중계)으로는 약 1.8초 뒤에 이동이 일어나
// 네트워크 변동을 감안해 여유를 둔다.
const MIN_SETTLE_MS = 4000;

function isShortlinkHost(hostname) {
  return SHORTLINK_HOSTS.has(String(hostname || '').toLowerCase());
}

function isAllowedNavigationHost(targetUrl, pattern = DEFAULT_ALLOWED_NAVIGATION_HOSTS) {
  let hostname = '';
  try { hostname = new URL(targetUrl).hostname; } catch (_) { return false; }
  return pattern.test(hostname);
}

// BrowserWindow/session은 호출자(main.js)에서 주입한다. 이 파일 자체는 'electron'을
// require하지 않으므로 순수 Node 테스트에서도 가짜 생성자를 넣어 검증할 수 있다.
function createShortlinkResolver({ BrowserWindow, session, timeoutMs = DEFAULT_TIMEOUT_MS, maxNavigations = DEFAULT_MAX_NAVIGATIONS, allowedHostPattern = DEFAULT_ALLOWED_NAVIGATION_HOSTS } = {}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow가 필요합니다.');
  return function resolveShortlink(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let navigations = 0;
      let win;
      let timer;
      const chain = [url];
      const pushChain = (value) => { if (value && chain[chain.length - 1] !== value) chain.push(value); };
      const partitionName = 'connect-shortlink-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const windowToDestroy = win;
        callback(value);
        // 창 파괴는 다음 작업을 막지 않도록 비동기로 미룬다. 콜백(resolve/reject) 직후
        // 동기적으로 destroy()를 호출하면 호출자의 다음 단계(예: 상세 페이지 수집)가
        // 지연되거나 실패하는 사례가 있었다.
        setImmediate(() => {
          try { if (windowToDestroy && !windowToDestroy.isDestroyed()) windowToDestroy.destroy(); } catch (_) {}
        });
      };
      timer = setTimeout(() => finish(reject, new Error('발급 링크 주소 확인 시간이 초과되었습니다.')), timeoutMs);
      try {
        win = new BrowserWindow({
          show: false,
          width: 800,
          height: 600,
          webPreferences: {
            partition: session ? undefined : partitionName,
            session: session ? session.fromPartition(partitionName) : undefined,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
      } catch (error) { finish(reject, error); return; }
      const webContents = win.webContents;
      try {
        webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
          callback({ cancel: !isAllowedNavigationHost(details.url, allowedHostPattern) });
        });
      } catch (_) {}
      const onNavigated = (_event, navigatedUrl) => {
        navigations += 1;
        if (navigations > maxNavigations) { finish(reject, new Error('발급 링크 이동 횟수가 너무 많습니다.')); return; }
        if (!isAllowedNavigationHost(navigatedUrl, allowedHostPattern)) { finish(reject, new Error('허용되지 않은 주소로 이동했습니다.')); return; }
        pushChain(navigatedUrl);
      };
      webContents.on('did-navigate', onNavigated);
      webContents.on('did-navigate-in-page', onNavigated);
      webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        if (settled || errorCode === -3) return; // -3 ERR_ABORTED는 우리가 취소한 요청일 수 있어 무시
        finish(reject, new Error('발급 링크 페이지를 불러오지 못했습니다: ' + errorDescription));
      });
      const pollStable = () => {
        let lastUrl = null;
        let stableCount = 0;
        const startedAt = Date.now();
        const check = () => {
          if (settled) return;
          let current;
          try { current = webContents.getURL(); } catch (_) { current = ''; }
          if (current === lastUrl) stableCount += 1;
          else { stableCount = 0; lastUrl = current; }
          let waitingForProduct = false;
          try {
            const currentUrl = new URL(current);
            waitingForProduct = isShortlinkHost(currentUrl.hostname) || (currentUrl.hostname === 'brandconnect.naver.com' && currentUrl.pathname.startsWith('/connect/'));
          } catch (_) { waitingForProduct = true; }
          if (!waitingForProduct && stableCount >= STABLE_CHECKS_REQUIRED && current && current !== url && (Date.now() - startedAt) >= MIN_SETTLE_MS) {
            pushChain(current);
            finish(resolve, { finalUrl: current, chain });
            return;
          }
          setTimeout(check, STABLE_POLL_MS);
        };
        check();
      };
      webContents.once('did-finish-load', pollStable);
      win.loadURL(url).catch((error) => finish(reject, error));
    });
  };
}

module.exports = { createShortlinkResolver, isShortlinkHost, isAllowedNavigationHost, SHORTLINK_HOSTS };
