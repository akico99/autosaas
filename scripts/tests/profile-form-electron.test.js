'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const root = path.join(__dirname, '..', '..');
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8' };
const files = {
  '/app/connect-ui-fixture.html': 'scripts/tests/fixtures/connect-ui.html',
  '/app/travel-connect.html': 'app/travel-connect.html',
  '/app/travel-connect.css': 'app/travel-connect.css',
  '/app/travel-connect.js': 'app/travel-connect.js',
  '/src/connect/policy.js': 'src/connect/policy.js',
  '/src/topics/publishPlan.js': 'src/topics/publishPlan.js',
  '/src/topics/editorGuard.js': 'src/topics/editorGuard.js',
  '/src/topics/editorDelivery.js': 'src/topics/editorDelivery.js',
  '/src/topics/travelConnect.js': 'src/topics/travelConnect.js',
};

test('the inline travel profile form replaces the unsupported prompt() dialog and survives a mixed-topic save response', { timeout: 30000 }, async () => {
  const server = http.createServer((req, res) => {
    const relative = files[new URL(req.url, 'http://localhost').pathname];
    if (!relative) { res.writeHead(404); res.end('missing'); return; }
    const file = path.join(root, relative);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    if (relative === 'scripts/tests/fixtures/connect-ui.html') {
      const appHtml = fs.readFileSync(path.join(root, 'app/app.html'), 'utf8');
      const appCss = appHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
      res.end(fs.readFileSync(file, 'utf8').replace('</head>', '<style>' + appCss + '</style></head>'));
    } else fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-form-electron-'));
  const mainJs = `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'user-data'));app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,cb)=>{const u=new URL(d.url);cb({cancel:!(u.hostname==='127.0.0.1'||u.hostname==='localhost'||u.protocol==='data:'||u.protocol==='file:')});});const w=new BrowserWindow({show:false,width:1280,height:980,webPreferences:{nodeIntegration:true,contextIsolation:false}});w.loadURL('http://127.0.0.1:${port}/app/connect-ui-fixture.html');});`;
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'profile-form-fixture', version: '1.0.0', main: 'main.js' }));
  fs.writeFileSync(path.join(temp, 'main.js'), mainJs);
  let electronApp;
  try {
    const electronEnv = { ...process.env };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    delete electronEnv.NODE_OPTIONS;
    Object.assign(electronEnv, { ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' });
    electronApp = await _electron.launch({ args: [temp], cwd: temp, env: electronEnv, timeout: 20000 });
    const page = await electronApp.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForSelector('#topic-travel-tab', { timeout: 10000 });
    await page.locator('#topic-travel-tab').click({ timeout: 10000 });
    await page.waitForFunction(() => { const e = document.getElementById('tc-pane'); return e && getComputedStyle(e).display !== 'none'; }, { timeout: 10000 });
    await page.locator('#tc-advanced').evaluate((el) => { el.open = true; });

    // 실제 서버(electron/main.js)의 topicProfiles:save는 다른 주제(사주)의 프로필을 함께
    // 반환한다. 공유 fixture를 건드리지 않고 이 특정 응답 형태만 재현한다.
    await page.evaluate(() => {
      window.fixtureCalls.profileSaveCalls = 0;
      window.api.topicProfilesSave = async (profiles) => {
        window.fixtureCalls.profileSaveCalls += 1;
        return { ok: true, profiles: [{ key: 'other-topic-profile', topicId: 'saju', name: '다른 주제 프로필' }, ...profiles] };
      };
    });

    await page.locator('#tc-profile-add').click({ timeout: 10000 });
    await page.waitForSelector('#tc-profile-form:not([hidden])', { timeout: 10000 });
    await page.locator('#tc-profile-form [name="name"]').fill('첫 번째 새 프로필', { timeout: 10000 });
    await page.locator('#tc-profile-form button[type="submit"]').click({ timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('tc-profile-form').hidden === true, { timeout: 10000 });
    const optionsAfterFirst = await page.locator('#tc-profile option').allTextContents();
    assert.ok(optionsAfterFirst.some((text) => text.includes('첫 번째 새 프로필')), 'the inline form adds a selectable profile without a native prompt() dialog');
    assert.equal(optionsAfterFirst.some((text) => text.includes('다른 주제 프로필')), false, 'a profile from another topic is not shown in this dropdown');

    await page.locator('#tc-profile-add').click({ timeout: 10000 });
    await page.waitForSelector('#tc-profile-form:not([hidden])', { timeout: 10000 });
    await page.locator('#tc-profile-form [name="name"]').fill('두 번째 새 프로필', { timeout: 10000 });
    await page.locator('#tc-profile-form button[type="submit"]').click({ timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('tc-profile-form').hidden === true, { timeout: 10000 });
    const optionsAfterSecond = await page.locator('#tc-profile option').allTextContents();
    assert.ok(optionsAfterSecond.some((text) => text.includes('두 번째 새 프로필')), 'a second save succeeds even though the first response mixed in another topic\'s profile');
    assert.equal(await page.evaluate(() => window.fixtureCalls.profileSaveCalls), 2);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (electronApp) await electronApp.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
