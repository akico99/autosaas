'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const electronPath = require('electron');
const fixturePath = path.join(__dirname, 'fixtures', 'connect-main-electron-ipc');

test('real Electron main-frame IPC imports fixture data and rejects a same-URL subframe', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-electron-ipc-'));
  const profile = path.join(temp, 'profile');
  const child = spawn(electronPath, [fixturePath, '--no-sandbox', '--disable-gpu', '--headless'], {
    cwd: root,
    env: { ...process.env, CONNECT_TEST_PROFILE: profile, CONNECT_TEST_REPO: root },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  try {
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Electron IPC fixture timed out. stdout=${stdout}\nstderr=${stderr}`));
      }, 25000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(exit.code, 0, `Electron fixture exited ${exit.code ?? exit.signal}.\nstdout=${stdout}\nstderr=${stderr}`);
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('CONNECT_IPC_RESULT '));
    assert.ok(line, `Electron fixture did not return a result.\nstdout=${stdout}\nstderr=${stderr}`);
    const report = JSON.parse(line.slice('CONNECT_IPC_RESULT '.length));
    assert.equal(report.mainFrameHasIsMainFrame, false, 'runtime WebFrameMain should match the documented API surface');
    assert.equal(report.subframeDenied, true, 'a same-origin/path subframe must fail frame identity validation');
    assert.equal(report.result.ok, true, report.result.error);
    assert.equal(report.result.imported.product.name, 'Electron fixture 여행 상품');
    assert.equal(report.result.imported.sources[0].excerpt, 'fixture source excerpt');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
