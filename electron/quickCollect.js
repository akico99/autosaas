'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const EXTRACTION_SCRIPT = `(function(){
 try {
  try { window.scrollTo(0, document.body.scrollHeight); window.scrollTo(0,0); } catch(e) {}
  const text=(el)=>String(el && (el.innerText || el.textContent) || '').replace(/\\s+/g,' ').trim();
  const meta=(key)=>{const el=document.querySelector('meta[property="'+key+'"],meta[name="'+key+'"]');return el&&el.content||'';};
  const title=text(document.querySelector('h1'))||meta('og:title')||document.title||'';
  const siteName=meta('og:site_name')||'';
  const priceRe=/\\d[\\d,]*(?:\\.\\d+)?\\s*원/;
  let priceText='';
  for(const el of document.querySelectorAll('[class*=price i],[class*=Price i],[class*=amount i],[class*=cost i],[data-testid*=price i]')) { const t=text(el); const m=t.match(priceRe); if(m && m[0].replace(/\\D/g,'').length>=3){priceText=m[0];break;} }
  if(!priceText){const metaPrice=meta('product:price:amount')||meta('og:price:amount');const currency=meta('product:price:currency')||'KRW';if(metaPrice&&currency==='KRW')priceText=metaPrice.replace(/\\B(?=(\\d{3})+(?!\\d))/g,',')+'원';}
  if(!priceText){const all=(document.body&&document.body.innerText)||'';const m=all.match(priceRe);if(m&&m[0].replace(/\\D/g,'').length>=3)priceText=m[0];}
  const selectors=['main','article','[role=main]','[class*=product i]','[class*=detail i]','[class*=content i]','body'];
  let candidates=[];
  for(const selector of selectors){for(const el of document.querySelectorAll(selector)){const t=text(el);if(t.length>=80)candidates.push({text:t,score:t.length+(selector==='main'||selector==='article'?120:0)});}}
  candidates.sort((a,b)=>b.score-a.score);
  let summary=candidates[0]&&candidates[0].text||text(document.body);
  summary=summary.slice(0,6000);
  const main=document.querySelector('main,article,[role=main]')||document.body;
  const imgs=[]; const seen=new Set();
  const add=(url,w,h,alt)=>{try{const absolute=new URL(url,location.href).href;const low=(absolute+' '+(alt||'')).toLowerCase();if(!absolute.startsWith('https://')||seen.has(absolute)||['logo','icon','sprite','banner','profile','avatar','badge','.svg'].some((word)=>low.includes(word)))return;seen.add(absolute);imgs.push({url:absolute,width:Number(w)||0,height:Number(h)||0});}catch(e){}};
  add(meta('og:image'),1200,800,'');
  for(const img of main.querySelectorAll('img')){const w=img.naturalWidth||Number(img.getAttribute('width'))||0;const h=img.naturalHeight||Number(img.getAttribute('height'))||0;if(w>=300&&h>=200)add(img.currentSrc||img.src,w,h,img.alt||'');}
  const description=meta('og:description')||meta('description')||'';
  return {title,siteName,priceText,summary:description&&summary.length<200?description+'\\n'+summary:summary,images:imgs.slice(0,20)};
 } catch(error) { return {error:'quick extraction: '+String(error&&error.stack||error)}; }
})()`;

function validateHttpsUrl(raw) {
  if (typeof raw !== 'string' || !raw || /[\u0000-\u0020\u007f]/.test(raw)) throw new Error('HTTPS 상품 링크를 입력해 주세요.');
  let url; try { url = new URL(raw); } catch (_) { throw new Error('링크 주소를 확인해 주세요.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('HTTPS 상품 링크만 사용할 수 있습니다.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^127\.|^10\.|^192\.168\.|^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('사용할 수 없는 링크 주소입니다.');
  return url;
}

function requestBuffer(url, { referer, ua, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let target; try { target = validateHttpsUrl(url); } catch (error) { reject(error); return; }
    const req = https.get(target, { headers: { 'User-Agent': ua || '', Referer: referer || '', Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); if (redirects >= 3) { reject(new Error('이미지 이동 횟수가 너무 많습니다.')); return; }
        requestBuffer(new URL(res.headers.location, target).href, { referer, ua, redirects: redirects + 1 }).then(resolve, reject); return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`이미지 요청 실패 (${res.statusCode})`)); return; }
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(new Error('이미지 파일이 너무 큽니다.')); else chunks.push(chunk); });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || '').split(';')[0].toLowerCase() }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('이미지 요청 시간이 초과되었습니다.'))); req.on('error', reject);
  });
}

function extensionFor(url, contentType) {
  const fromType = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[contentType];
  if (fromType) return fromType;
  try { const ext = path.extname(new URL(url).pathname).toLowerCase(); return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : '.jpg'; } catch (_) { return '.jpg'; }
}

function createQuickCollector({ scrapeRendered, nativeImage, userDataPath, partition = 'persist:naver', userAgent = '' } = {}) {
  if (typeof scrapeRendered !== 'function') throw new TypeError('scrapeRendered 함수가 필요합니다.');
  return async function collectQuickProduct(finalUrl, id) {
    const target = validateHttpsUrl(finalUrl);
    const rendered = await scrapeRendered(target.href, EXTRACTION_SCRIPT, 16000, partition, userAgent, {
      timeoutMs: 18000,
      navigationTimeoutMs: 30000,
      readyScript: "JSON.stringify((function(){return ((document.body&&document.body.innerText)||'').trim().length>=200})())",
    });
    let data = rendered;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { data = {}; } }
    const title = String(data.title || '').trim(); const summary = String(data.summary || '').trim();
    if (summary.length < 200) throw Object.assign(new Error('상품 페이지의 설명을 충분히 읽지 못했습니다. 페이지가 열린 뒤 다시 시도해 주세요.'), { stage: 'collect' });
    const product = { title: title || '상품 정보', siteName: String(data.siteName || target.hostname), priceText: String(data.priceText || ''), summary };
    const folder = path.join(userDataPath, 'quick-connect', id); fs.mkdirSync(folder, { recursive: true });
    const images = [];
    for (const candidate of (Array.isArray(data.images) ? data.images : []).slice(0, 20)) {
      if (images.length >= 8) break;
      try {
        const response = await requestBuffer(candidate.url, { referer: target.href, ua: userAgent });
        if (response.buffer.length <= 15 * 1024) continue;
        const image = nativeImage && nativeImage.createFromBuffer(response.buffer);
        if (!image || image.isEmpty()) continue;
        const { width, height } = image.getSize(); if (width < 400 || height < 200) continue;
        let ext = extensionFor(candidate.url, response.contentType); let buffer = response.buffer;
        if (ext === '.webp' || ext === '.gif') { ext = '.jpg'; buffer = image.toJPEG(92); }
        if (!['.jpg', '.png'].includes(ext)) { ext = '.jpg'; buffer = image.toJPEG(92); }
        const file = path.join(folder, `img-${images.length + 1}${ext}`); fs.writeFileSync(file, buffer);
        images.push({ id: `img-${images.length + 1}`, path: file, url: candidate.url, width, height });
      } catch (_) { /* one unavailable image must not stop analysis */ }
    }
    return { product, images };
  };
}

module.exports = { EXTRACTION_SCRIPT, validateHttpsUrl, createQuickCollector };
