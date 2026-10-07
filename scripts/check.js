// 정적 일관성 검사 — 렌더러(window.api.*) ↔ preload(노출) ↔ main(ipcMain.handle) 세 층이 맞물리는지,
// 그리고 app/*.html 인라인 스크립트가 문법적으로 유효한지 확인한다. `npm run check`.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fail = 0;
const bad = (msg) => { console.error('✗ ' + msg); fail++; };
const ok = (msg) => console.log('✓ ' + msg);

// 1) preload 노출 vs main 핸들러
const preload = read('electron/preload.js');
const main = read('electron/main.js');
const invoked = new Set([...preload.matchAll(/invoke\('([\w:]+)'/g)].map((m) => m[1]));
const handled = new Set([...main.matchAll(/ipcMain\.handle\('([\w:]+)'/g)].map((m) => m[1]));
for (const ch of invoked) if (!handled.has(ch)) bad(`preload가 부르지만 main에 핸들러 없음: ${ch}`);
for (const ch of handled) if (!invoked.has(ch)) console.log(`  (참고) main 핸들러가 preload에서 미사용: ${ch}`);
if (![...invoked].some((c) => !handled.has(c))) ok(`IPC 채널 ${invoked.size}개 모두 핸들러 존재`);

// 2) 렌더러 window.api.* vs preload 노출
const exposed = new Set([...preload.matchAll(/^\s*(\w+):\s*\(/gm)].map((m) => m[1]));
const pages = ['app/app.html', 'app/login.html'];
const externalRendererScripts = ['app/travel-connect.js'];
let missing = 0;
for (const pg of pages) {
  const used = new Set([...read(pg).matchAll(/window\.api\.(\w+)/g)].map((m) => m[1]));
  for (const u of used) if (!exposed.has(u)) { bad(`${pg}: window.api.${u} 가 preload에 없음`); missing++; }
}
for (const file of externalRendererScripts) {
  const script = read(file);
  for (const method of new Set([...script.matchAll(/\bapi\.(\w+)\s*\(/g)].map((m) => m[1]))) {
    if (!exposed.has(method)) bad(`${file}: api.${method} 가 preload에 없음`);
  }
}
if (!missing) ok('렌더러가 쓰는 window.api.* 전부 preload에 노출됨');

// 3) 인라인 스크립트 문법 + main/preload/src 문법
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blogauto-check-'));
function checkJs(label, code) {
  const f = path.join(tmp, label.replace(/[^\w.]/g, '_') + '.js');
  fs.writeFileSync(f, code);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok(`문법 OK: ${label}`); }
  catch (e) { bad(`문법 오류: ${label}\n${String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')}`); }
}
for (const pg of pages) {
  const html = read(pg);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  scripts.forEach((m, i) => checkJs(`${pg}#${i}`, m[1]));
}
for (const file of externalRendererScripts) checkJs(file, read(file));
for (const f of ['electron/main.js', 'electron/preload.js']) checkJs(f, read(f));
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
for (const f of walk('src')) checkJs(f, read(f));

// 4) 금지 잔재 — 제거한 회원등급 코드가 다시 들어오지 않게
const forbidden = /_tier\b|applyTier|booster:keywords/;
for (const f of ['electron/main.js', 'electron/preload.js', ...pages, ...walk('src')]) {
  const m = read(f).match(forbidden);
  if (m) bad(`${f}: 제거된 등급 코드 잔재 "${m[0]}"`);
}
if (!fail) ok('등급 코드 잔재 없음');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail}건 실패` : '\n모두 통과');
process.exit(fail ? 1 : 0);
