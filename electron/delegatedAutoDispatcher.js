'use strict';

function createDelegatedAutoDispatcher({ getWindow, getAppUrl, onStateChange = () => {}, onDispatch = () => {}, onError = () => {}, timeoutMs = 90 * 60 * 1000 }) {
  let active = false;
  let kind = '';
  let dispatched = false;
  let waitingContents = null;
  let finishListener = null;
  let failListener = null;
  let boundWindow = null;
  let closeListener = null;
  let timeout = null;
  let navigating = false;

  function getState() { return { active, kind, dispatched }; }
  function publish() { onStateChange(getState()); }
  function removeWaiters() {
    if (waitingContents) {
      if (finishListener) waitingContents.removeListener('did-finish-load', finishListener);
      if (failListener) waitingContents.removeListener('did-fail-load', failListener);
    }
    waitingContents = null; finishListener = null; failListener = null;
  }
  function complete(error) {
    if (!active) return false;
    removeWaiters();
    if (boundWindow && closeListener) boundWindow.removeListener('closed', closeListener);
    boundWindow = null; closeListener = null;
    if (timeout) clearTimeout(timeout);
    timeout = null; active = false; kind = ''; dispatched = false; navigating = false;
    publish();
    if (error) onError(error);
    return true;
  }
  function waitForLoad(contents) {
    if (waitingContents === contents) return;
    removeWaiters();
    waitingContents = contents;
    finishListener = () => { removeWaiters(); navigating = false; route(); };
    failListener = (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      complete(new Error('예약 자동 실행을 위해 앱 화면을 열지 못했습니다: ' + (description || code || '페이지 로드 실패')));
    };
    contents.once('did-finish-load', finishListener);
    contents.on('did-fail-load', failListener);
  }
  function isAppPage(url) {
    try { return new URL(url).pathname.toLowerCase().endsWith('/app/app.html'); } catch (_) { return false; }
  }
  function route() {
    if (!active || dispatched) return;
    const win = getWindow();
    if (!win) return;
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) { complete(new Error('예약 자동 실행 창이 닫혔습니다.')); return; }
    if (boundWindow !== win) {
      if (boundWindow && closeListener) boundWindow.removeListener('closed', closeListener);
      boundWindow = win;
      closeListener = () => complete(new Error('예약 자동 실행 창이 닫혔습니다.'));
      win.once('closed', closeListener);
    }
    const contents = win.webContents;
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
    const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
    if (isAppPage(url) && /[?&]auto=1(?:&|$)/.test(url)) { complete(); return; }
    if (isAppPage(url)) {
      if (typeof contents.isLoadingMainFrame === 'function' && contents.isLoadingMainFrame()) { waitForLoad(contents); return; }
      try {
        dispatched = true;
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => complete(new Error('예약 자동 실행이 시간 안에 종료되지 않았습니다.')), timeoutMs);
        if (timeout && typeof timeout.unref === 'function') timeout.unref();
        contents.send('run-auto', { kind });
        onDispatch(kind);
      } catch (error) { complete(error); }
      return;
    }
    if (navigating) return;
    navigating = true;
    waitForLoad(contents);
    try {
      Promise.resolve(win.loadURL(getAppUrl())).catch((error) => complete(error));
    } catch (error) { complete(error); }
  }

  return {
    request(nextKind) {
      if (active) return false;
      active = true;
      kind = ['connect', 'search', 'home'].includes(nextKind) ? nextKind : 'home';
      publish();
      timeout = setTimeout(() => complete(new Error('예약 자동 실행 화면을 준비하지 못했습니다.')), timeoutMs);
      if (timeout && typeof timeout.unref === 'function') timeout.unref();
      route();
      return true;
    },
    retry: route,
    complete: () => complete(),
    getState,
  };
}

module.exports = { createDelegatedAutoDispatcher };
