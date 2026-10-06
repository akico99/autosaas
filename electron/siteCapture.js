'use strict';

const crypto = require('node:crypto');
const fsDefault = require('node:fs');
const pathDefault = require('node:path');
const { validateCapturePages } = require('../src/topics/assets');

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HIDE_SCROLLBARS = '::-webkit-scrollbar{display:none!important}html,body{scrollbar-width:none!important}';

function createTopicCaptureSession(options, { BrowserWindow, onCreated = () => {}, onClosed = () => {} } = {}) {
  if (typeof BrowserWindow !== 'function') throw new Error('캡처용 BrowserWindow를 주입해야 합니다.');
  const scale = Number(options.deviceScaleFactor) || 1;
  const win = new BrowserWindow({
    show: false,
    width: Math.round(options.viewport.width * scale),
    height: Math.round(options.viewport.height * scale),
    webPreferences: { partition: options.partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  onCreated(win);
  try { win.webContents.setUserAgent(options.userAgent); } catch (_) {}
  let mainStatus = 200;
  let countedClosed = false;
  win.webContents.on('did-frame-navigate', (_event, _url, statusCode, isMainFrame) => {
    if (isMainFrame && Number.isFinite(Number(statusCode)) && Number(statusCode) > 0) mainStatus = Number(statusCode);
  });
  win.once('closed', () => {
    if (countedClosed) return;
    countedClosed = true;
    onClosed(win);
  });
  return {
    load: (url) => new Promise((resolve, reject) => {
      mainStatus = 200;
      const timer = setTimeout(() => reject(new Error('캡처 페이지 로드 시간 초과')), 25000);
      const done = async () => {
        clearTimeout(timer);
        try {
          win.webContents.setZoomFactor(scale);
          await win.webContents.insertCSS(HIDE_SCROLLBARS);
          resolve();
        } catch (error) { reject(error); }
      };
      const failed = (_event, code, description) => { clearTimeout(timer); reject(new Error(description || `페이지 로드 실패(${code})`)); };
      win.webContents.once('did-finish-load', done);
      win.webContents.once('did-fail-load', failed);
      win.loadURL(url).catch((error) => { clearTimeout(timer); reject(error); });
    }),
    inspect: async () => ({ ...await win.webContents.executeJavaScript(`({title:document.title||'',text:(document.body&&document.body.innerText)||'',viewportHeight:window.innerHeight||915,scrollHeight:document.documentElement.scrollHeight||0,blocked:((document.body&&document.body.innerText)||'').includes('검색 서비스 이용이 제한되었습니다')})`), status: mainStatus }),
    screenshot: async () => {
      let metrics;
      try {
        metrics = await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ cw: document.documentElement ? document.documentElement.clientWidth : null, ih: window.innerHeight }))))`);
      } catch (_) {}
      const cw = Number(metrics && metrics.cw);
      const ih = Number(metrics && metrics.ih);
      const rect = Number.isFinite(cw) && cw > 0 && Number.isFinite(ih) && ih > 0
        ? { x: 0, y: 0, width: Math.round(cw * scale), height: Math.round(ih * scale) }
        : null;
      const image = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
      return image.toPNG();
    },
    scrollBy: async (amount) => win.webContents.executeJavaScript(`window.scrollBy(0,${Number(amount) || 0})`),
    close: async () => { if (!win.isDestroyed()) win.destroy(); },
  };
}

async function captureTopicSite(topic, {
  outDir,
  partition = 'persist:topic-capture',
  createSession,
  sleep = sleepDefault,
  fs = fsDefault,
  path = pathDefault,
  date = new Date(),
} = {}) {
  if (!outDir) throw new Error('캡처 저장 경로가 필요합니다.');
  if (typeof createSession !== 'function') throw new Error('캡처 세션을 주입해야 합니다.');
  const pages = validateCapturePages(topic);
  fs.mkdirSync(outDir, { recursive: true });
  const session = await createSession({
    partition,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  });
  const items = [];
  const skipped = [];
  try {
    for (const page of pages) {
      let previousHash = '';
      try {
        await session.load(page.url);
        await sleep(2500);
        let info = await session.inspect();
        const status = Number(info && info.status || 200);
        const pageText = String(info && (info.text || info.bodyText) || '').trim();
        if (info && info.blocked) { skipped.push({ pageId: page.id, reason: 'blocked' }); continue; }
        if (status >= 400 || /(?:^|\s)404(?:\s|$)/.test(`${info && info.title || ''} ${pageText}`)) { skipped.push({ pageId: page.id, reason: 'http-error', status }); continue; }
        if (!pageText) { skipped.push({ pageId: page.id, reason: 'blank' }); continue; }
        const viewportHeight = Math.max(1, Number(info.viewportHeight) || 915);
        let scrollTop = 0;
        for (let slice = 0; slice < 3; slice += 1) {
          const image = await session.screenshot({ fullPage: false });
          const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image && (image.buffer || image.data) || image || []);
          const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
          if (sha1 !== previousHash) {
            const id = `${page.id}-${slice + 1}`;
            const imagePath = path.join(outDir, `${id}.png`);
            fs.writeFileSync(imagePath, bytes);
            items.push({ id, pageId: page.id, url: page.url, slice: slice + 1, path: imagePath, caption: page.caption, tags: page.tags || [], sha1 });
            previousHash = sha1;
          }
          if (slice === 2) break;
          const scrollHeight = Math.max(viewportHeight, Number(info.scrollHeight) || viewportHeight);
          if (scrollTop + viewportHeight >= scrollHeight) break;
          const distance = Math.round(viewportHeight * 0.9);
          await session.scrollBy(distance);
          scrollTop += distance;
          info = await session.inspect();
        }
      } catch (error) {
        skipped.push({ pageId: page.id, reason: 'capture-error', error: String(error && error.message || error) });
      }
    }
  } finally {
    try { await session.close(); } catch (_) {}
  }
  const manifest = { capturedAt: date.toISOString(), items, skipped };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { ...manifest, manifestPath: path.join(outDir, 'manifest.json') };
}

module.exports = { captureTopicSite, createTopicCaptureSession };
