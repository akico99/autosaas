'use strict';

const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const path = require('node:path');
const repo = process.env.CONNECT_TEST_REPO;
const profile = process.env.CONNECT_TEST_PROFILE;
const { createShortlinkResolver } = require(path.join(repo, 'electron/shortlinkResolver'));

app.setPath('userData', profile);

const server = http.createServer((request, response) => {
  if (request.url === '/shortlink') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end('<!doctype html><script>setTimeout(function(){location.href="/bridge";},30);</script>');
  }
  if (request.url === '/bridge') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end('<!doctype html><script>setTimeout(function(){location.href="/final";},30);</script>');
  }
  if (request.url === '/final') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end('<!doctype html><body>final destination page</body>');
  }
  if (request.url === '/offhost-shortlink') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end('<!doctype html><script>setTimeout(function(){location.href=location.href.replace("127.0.0.1","localhost").replace("offhost-shortlink","blocked-target");},30);</script>');
  }
  if (request.url === '/blocked-target') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end('<!doctype html><body>should not be reached</body>');
  }
  response.writeHead(404);
  response.end('not found');
});

app.whenReady().then(() => {
  server.listen(0, '127.0.0.1', async () => {
    // 실제 앱처럼 메인 창을 유지한 상태에서 해석기를 실행한다. 마지막 창이 완전히
    // 파괴되면 Electron이 자동 종료되므로, 해석기 전용 창만으로 검증하면 production과
    // 다른 생명주기가 된다.
    const keepAlive = new BrowserWindow({ show: false, width: 100, height: 100 });
    await keepAlive.loadURL('about:blank');
    const port = server.address().port;
    const resolveShortlink = createShortlinkResolver({
      BrowserWindow, session,
      allowedHostPattern: /^127\.0\.0\.1$/,
      timeoutMs: 8000,
    });
    const report = {};
    try {
      const resolved = await resolveShortlink(`http://127.0.0.1:${port}/shortlink`);
      report.resolvedFinalUrl = resolved.finalUrl;
      report.resolvedChain = resolved.chain;
      report.resolvedOk = true;
    } catch (error) {
      report.resolvedOk = false;
      report.resolvedError = error.message;
    }
    try {
      await resolveShortlink(`http://127.0.0.1:${port}/offhost-shortlink`);
      report.offHostRejected = false;
    } catch (error) {
      report.offHostRejected = true;
      report.offHostError = error.message;
    }
    process.stdout.write('SHORTLINK_RESULT ' + JSON.stringify(report) + '\n');
    if (!report.resolvedOk || !report.offHostRejected) process.exitCode = 1;
    server.close(() => app.quit());
  });
});

app.on('window-all-closed', () => app.quit());
