'use strict';

// Run with: node_modules/electron/dist/electron.exe scripts/quick-analyze-live-host <issued-link>
const { app, BrowserWindow, session, nativeImage } = require('electron');
const { createRenderedCollector } = require('../electron/renderedCollector');
const { createShortlinkResolver } = require('../electron/shortlinkResolver');
const { createQuickCollector } = require('../electron/quickCollect');
const quickPost = require('../src/connect/quickPost');
const { runClaude } = require('../src/generator/runClaude');
const fs = require('node:fs');
const path = require('node:path');
const resultFile = path.join(app.getPath('temp'), 'blog-auto-quick-analyze-live.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
app.whenReady().then(async () => {
  try {
    const issuedUrl = process.argv.find((argument) => /^https:\/\//i.test(argument));
    if (!issuedUrl) throw new Error('발급 링크 인수가 필요합니다.');
    const parsed = new URL(issuedUrl);
    let finalUrl = issuedUrl;
    if (parsed.hostname.toLowerCase() === 'naver.me') {
      const resolved = await createShortlinkResolver({ BrowserWindow, session })(issuedUrl);
      finalUrl = resolved.finalUrl;
    }
    const id = `live-${Date.now()}`;
    const collect = createQuickCollector({ scrapeRendered: createRenderedCollector({ BrowserWindow }), nativeImage,
      userDataPath: app.getPath('userData'), partition: 'persist:quick-collect', userAgent: UA });
    const { product, images } = await collect(finalUrl, id);
    let keywords;
    try {
      const { text } = await runClaude({ system: '주어진 상품 자료로 검색 키워드만 JSON으로 제안합니다.', user: quickPost.buildKeywordPrompt(product), model: 'haiku' });
      keywords = quickPost.parseKeywordsResponse(text, product.title);
    } catch (error) { keywords = quickPost.fallbackKeywords(product.title); console.warn('키워드 모델 실패, 제목 기반 제안 사용:', error.message); }
    const result = { title: product.title, priceText: product.priceText, textLength: product.summary.length, imageCount: images.length, keywords };
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('LIVE_SMOKE_ERROR:', error.message);
    if (error && error.cause) console.error('LIVE_SMOKE_CAUSE:', error.cause.stack || error.cause.message || error.cause);
    try { fs.writeFileSync(resultFile, JSON.stringify({ error: error.message }, null, 2), 'utf8'); } catch (_) {}
    process.exitCode = 1;
  } finally { app.quit(); }
});
