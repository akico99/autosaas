'use strict';

// Electron-free helpers for the link-first Connect flow.
const { getConnectDisclosure } = require('./policy');
function stripCodeFence(text) { return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(); }
function parseJsonObject(text) {
  const clean = stripCodeFence(text);
  try { return JSON.parse(clean); } catch (_) {}
  const start = clean.indexOf('{'); const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
  throw new Error('AI 응답에서 JSON을 찾지 못했습니다.');
}
function fallbackKeywords(title) {
  const words = String(title || '').replace(/https?:\/\/\S+/gi, ' ').replace(/[|·()[\]{}<>]/g, ' ')
    .split(/\s+/).map((word) => word.replace(/[^가-힣A-Za-z0-9]/g, '')).filter((word) => word.length >= 2);
  const stop = new Set(['공식', '최저가', '특가', '예약', '상품', '판매', '구매', '추천', '네이버', '포함', '무료']);
  const terms = [...new Set(words.filter((word) => !stop.has(word)))]; const candidates = [];
  for (let size = 3; size >= 1; size -= 1) for (let i = 0; i + size <= terms.length; i += 1) {
    const value = terms.slice(i, i + size).join(' '); if (value.length >= 2 && value.length <= 32 && !candidates.includes(value)) candidates.push(value);
  }
  const result = candidates.slice(0, 3);
  while (result.length < 3) result.push(`${terms[0] || '상품'} 정보${result.length ? ` ${result.length + 1}` : ''}`);
  return result.map((keyword) => ({ keyword, reason: '상품명에서 핵심 검색어를 골랐습니다.' }));
}
function parseKeywordsResponse(text, title = '') {
  let parsed; try { parsed = parseJsonObject(text); } catch (_) { return fallbackKeywords(title); }
  const raw = Array.isArray(parsed) ? parsed : parsed && parsed.keywords; if (!Array.isArray(raw)) return fallbackKeywords(title);
  const seen = new Set(); const keywords = [];
  for (const item of raw) {
    const keyword = String(typeof item === 'string' ? item : item && item.keyword || '').trim().replace(/\s+/g, ' ');
    const key = keyword.toLocaleLowerCase('ko-KR'); if (!keyword || keyword.length > 60 || seen.has(key)) continue;
    seen.add(key); keywords.push({ keyword, reason: String(item && item.reason || '상품 정보와 검색 의도를 반영했습니다.').trim().slice(0, 40) });
    if (keywords.length === 3) break;
  }
  if (keywords.length < 3) for (const item of fallbackKeywords(title)) {
    if (keywords.length >= 3) break;
    if (!seen.has(item.keyword.toLocaleLowerCase('ko-KR'))) { seen.add(item.keyword.toLocaleLowerCase('ko-KR')); keywords.push(item); }
  }
  return keywords;
}
function detectKind(url) {
  let parsed; try { parsed = new URL(url); } catch (_) { return 'shopping'; }
  const host = parsed.hostname.toLowerCase(); const path = parsed.pathname.toLowerCase();
  if (host === 'pkgtour.naver.com' || /(^|\.)(travel|hotel|flight|tour)\.naver\.com$/.test(host)
      || (/\.naver\.com$/.test(host) && /\/(travel|pkgtour|hotel|flight|tour)(\/|$)/.test(path))) return 'travel';
  return 'shopping';
}
function cleanModelText(value) {
  return String(value || '').replace(/(?:https?:\/\/|www\.)[^\s)\]}>,]+/gi, '')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|kr|me|co\.kr)(?:\/[^\s)\]}>,]*)?/gi, '')
    .replace(/[ \t]{2,}/g, ' ').trim();
}
function normalizeModelPost(value) {
  const data = typeof value === 'string' ? parseJsonObject(value) : value;
  if (!data || typeof data !== 'object') throw new Error('글 응답 형식이 올바르지 않습니다.');
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  return { title: cleanModelText(data.title), blocks: blocks.map((block) => {
    if (!block || typeof block !== 'object') return null; const kind = String(block.kind || '').toLowerCase();
    if (kind === 'image') return { kind: 'image' };
    if (kind === 'heading') return { kind, text: cleanModelText(block.text || block.heading) };
    if (kind === 'text') return { kind, text: cleanModelText(block.text) };
    if (kind === 'table') return { kind, caption: cleanModelText(block.caption), columns: (Array.isArray(block.columns) ? block.columns : []).map(cleanModelText).filter(Boolean), rows: (Array.isArray(block.rows) ? block.rows : []).map((row) => Array.isArray(row) ? row.map(cleanModelText) : []).filter((row) => row.length) };
    if (kind === 'qna') return { kind, question: cleanModelText(block.question), answer: cleanModelText(block.answer) };
    return null;
  }).filter(Boolean) };
}
function assemblePost({ generated, keyword, kind, issuedUrl, assets = [], title: productTitle = '' } = {}) {
  const modelPost = normalizeModelPost(generated); const chosenKeyword = String(keyword || '').trim();
  let title = cleanModelText(modelPost.title) || chosenKeyword || productTitle || '상품 정보';
  if (chosenKeyword && !title.includes(chosenKeyword)) title = `${chosenKeyword} ${title}`.trim();
  const disclosure = getConnectDisclosure(kind === 'travel' ? 'travel' : 'shopping');
  const link = { kind: 'link', text: '상품 자세히 보기', href: issuedUrl };
  const usableAssets = assets.slice(0, 8).map((asset, index) => ({ id: String(asset.id || `img-${index + 1}`), path: asset.path, caption: cleanModelText(asset.caption || productTitle || '상품 이미지') }));
  const maxImages = Math.min(usableAssets.length, 6); let imageCount = 0; const blocks = [{ kind: 'text', text: disclosure }]; let introLinkAdded = false;
  for (const block of modelPost.blocks) {
    if (block.kind === 'image') { if (imageCount < maxImages) blocks.push({ kind: 'image', assetId: usableAssets[imageCount++].id }); continue; }
    blocks.push(block);
    if (!introLinkAdded && block.kind === 'text' && block.text) { blocks.push(link); introLinkAdded = true; }
  }
  if (!introLinkAdded) blocks.splice(1, 0, link);
  const targetImageCount = Math.min(usableAssets.length, 3);
  while (imageCount < targetImageCount) {
    const imageBlock = { kind: 'image', assetId: usableAssets[imageCount++].id };
    const headingIndex = blocks.map((block) => block.kind).lastIndexOf('heading');
    const firstLinkIndex = blocks.findIndex((block) => block.kind === 'link');
    blocks.splice(headingIndex >= 1 ? headingIndex + 1 : firstLinkIndex >= 0 ? firstLinkIndex + 1 : Math.min(blocks.length, 2), 0, imageBlock);
  }
  blocks.push(link); return { post: { title, blocks }, assets: usableAssets.slice(0, imageCount) };
}
function buildKeywordPrompt(product) {
  return `상품 페이지 자료를 보고 네이버에서 실제 검색할 만한 한국어 검색어 3개를 제안하세요. 2~4어절로, 목적지/상품 종류/특징을 포함하고 브랜드명만 쓰거나 전체 상품명을 그대로 쓰지 마세요. 이유는 40자 이내로 씁니다. 페이지에 없는 사실은 만들지 마세요. JSON만 출력하세요: {"keywords":[{"keyword":"...","reason":"..."}]}\n\n상품명: ${product.title}\n판매처: ${product.siteName}\n페이지 내용:\n${product.summary}`;
}
function buildWriterPrompt({ product, keyword, images = [], issuedUrl } = {}) {
  const imageSlots = Math.min(images.length, 6);
  return `네이버 블로그 검색 의도에 맞는 정보·추천 글을 한국어 존댓말로 작성하세요. 분량은 공백 포함 1,800~2,800자입니다. 실제 이용한 것처럼 꾸미지 말고 "다녀왔어요", "직접 먹어봤는데" 같은 1인칭 경험 표현은 쓰지 마세요. 아래 페이지 자료에 있는 사실만 사용하고, 가격은 작성 시점 기준이며 달라질 수 있다고 알려 주세요. 구조는 도입, 소제목 4~6개와 문단, 사실이 충분하면 짧은 요약 표, Q&A 3개, 링크를 확인하라는 마무리입니다. JSON만 출력하고 블록 형식은 {"title":"...","blocks":[{"kind":"text","text":"..."},{"kind":"heading","text":"..."},{"kind":"image"},{"kind":"table","caption":"...","columns":["..."],"rows":[["...","..."]]},{"kind":"qna","question":"...","answer":"..."}]} 입니다. 이미지 자리 블록은 도입 뒤와 여러 소제목 뒤에 총 ${imageSlots}개를 배치하세요. URL은 출력하지 마세요.\n\n검색 키워드: ${keyword}\n상품명: ${product.title}\n판매처: ${product.siteName}\n가격 표시: ${product.priceText || '페이지에서 확인되지 않음'}\n발급 링크를 본문에 직접 출력하지 마세요.\n페이지 자료:\n${product.summary}`;
}
module.exports = { stripCodeFence, parseJsonObject, fallbackKeywords, parseKeywordsResponse, detectKind, cleanModelText, normalizeModelPost, assemblePost, buildKeywordPrompt, buildWriterPrompt };
