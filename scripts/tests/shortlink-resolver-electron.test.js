'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const electronPath = require('electron');
const fixturePath = path.join(__dirname, 'fixtures', 'shortlink-resolver-electron');

test('real Electron shortlink resolver follows a client-side redirect chain and rejects off-allowlist navigation', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlink-resolver-'));
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
        reject(new Error(`Electron shortlink fixture timed out. stdout=${stdout}\nstderr=${stderr}`));
      }, 25000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(exit.code, 0, `Electron shortlink fixture exited ${exit.code ?? exit.signal}.\nstdout=${stdout}\nstderr=${stderr}`);
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('SHORTLINK_RESULT '));
    assert.ok(line, `Electron shortlink fixture did not return a result.\nstdout=${stdout}\nstderr=${stderr}`);
    const report = JSON.parse(line.slice('SHORTLINK_RESULT '.length));
    assert.equal(report.resolvedOk, true, report.resolvedError);
    assert.match(report.resolvedFinalUrl, /\/final$/);
    assert.ok(Array.isArray(report.resolvedChain), 'resolver must return a visited-address chain');
    assert.match(report.resolvedChain[0], /\/shortlink$/);
    assert.ok(report.resolvedChain.some((entry) => entry.includes('/bridge')), 'chain must include the brandconnect-style bridge hop');
    assert.match(report.resolvedChain[report.resolvedChain.length - 1], /\/final$/);
    assert.equal(report.offHostRejected, true, 'navigation to a disallowed host must be rejected');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
