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
    if (kind === 'image') return { kind: 'image', caption: cleanModelText(block.caption) };
    if (kind === 'heading') return { kind, text: cleanModelText(block.text || block.heading) };
    if (kind === 'text') return { kind, text: cleanModelText(block.text) };
    if (kind === 'summary') return { kind, title: cleanModelText(block.title), items: (Array.isArray(block.items) ? block.items : []).map(cleanModelText).filter(Boolean).slice(0, 6) };
    if (kind === 'table') return { kind, caption: cleanModelText(block.caption), columns: (Array.isArray(block.columns) ? block.columns : []).map(cleanModelText).filter(Boolean), rows: (Array.isArray(block.rows) ? block.rows : []).map((row) => Array.isArray(row) ? row.map(cleanModelText) : []).filter((row) => row.length) };
    if (kind === 'qna') return { kind, question: cleanModelText(block.question), answer: cleanModelText(block.answer) };
    return null;
  }).filter(Boolean) };
}

// ── 모바일 가독성 서식 ─────────────────────────────────────────────
// 기본값: 가운데 정렬(에디터 입력 단계) + 한 줄 20자 안팎(띄어쓰기에서만 끊음) + 문단 2~3줄.
// 강조는 ==문장== 표시를 연한 노란 글자 배경으로 바꾼다.
const LAYOUT = { lineChars: 20, paragraphLines: 3, maxParagraphLines: 4, highlight: '#fff5b1' };
const HIGHLIGHT_OPEN = '<span class="__se-node" style="background-color:' + LAYOUT.highlight + ';">';
function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function plainOf(value) { return String(value || '').replace(/==/g, ''); }
function splitSentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?…]|[다요죠]\.)\s+/).map((s) => s.trim()).filter(Boolean);
}
// 문장을 띄어쓰기 기준으로 lineChars 이하 줄로 나눈다(표시용 글자 수는 == 표시를 제외).
function wrapSentence(sentence, max = LAYOUT.lineChars) {
  const lines = []; let line = '';
  for (const word of sentence.split(' ').filter(Boolean)) {
    const next = line ? line + ' ' + word : word;
    if (line && plainOf(next).length > max) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
// 줄 목록(== 표시 포함)을 HTML로: 강조가 줄을 넘어가도 줄마다 span을 닫고 다시 연다.
function linesToHtml(lines, openAtStart = false) {
  let open = openAtStart;
  const html = lines.map((line) => {
    const parts = escapeHtml(line).split('==');
    let out = open ? HIGHLIGHT_OPEN : '';
    parts.forEach((part, index) => {
      if (index > 0) { out += open ? '</span>' : HIGHLIGHT_OPEN; open = !open; }
      out += part;
    });
    if (open) out += '</span>';
    return out;
  }).join('<br>');
  return { html, open };
}
// 긴 문단을 모바일용 짧은 줄·작은 문단 블록들로 바꾼다.
function formatTextBlocks(text) {
  const paragraphs = []; let current = [];
  for (const sentence of splitSentences(text)) {
    const lines = wrapSentence(sentence);
    if (current.length && (current.length >= LAYOUT.paragraphLines || current.length + lines.length > LAYOUT.maxParagraphLines)) { paragraphs.push(current); current = []; }
    current.push(...lines);
  }
  if (current.length) paragraphs.push(current);
  let open = false;
  return paragraphs.map((lines) => {
    const rendered = linesToHtml(lines, open); open = rendered.open;
    return { kind: 'text', text: lines.map(plainOf).join('\n'), html: rendered.html };
  });
}
function wrapPlain(text) { return splitSentences(plainOf(text)).flatMap((s) => wrapSentence(s)).join('\n'); }
function summaryBlock(block) {
  const head = '<b>' + escapeHtml(block.title || '한눈에 보기') + '</b>';
  const items = block.items.map((item) => linesToHtml(wrapSentence('✔ ' + item, LAYOUT.lineChars + 4)).html);
  return { kind: 'text', text: [block.title || '한눈에 보기', ...block.items.map((item) => '✔ ' + plainOf(item))].join('\n'), html: [head, ...items].join('<br>') };
}
function ensureTitleNumber(title, priceText, headingCount) {
  if (/\d/.test(title)) return title;
  const price = String(priceText || '').match(/\d[\d,]*\s*원/);
  if (price) return title + ' (' + price[0].replace(/\s+/g, '') + '대)';
  return title + ' | 핵심 ' + Math.max(3, headingCount) + '가지';
}

function assemblePost({ generated, keyword, kind, issuedUrl, assets = [], title: productTitle = '', priceText = '' } = {}) {
  const modelPost = normalizeModelPost(generated); const chosenKeyword = String(keyword || '').trim();
  let title = cleanModelText(modelPost.title) || chosenKeyword || productTitle || '상품 정보';
  if (chosenKeyword && !title.includes(chosenKeyword)) title = `${chosenKeyword} ${title}`.trim();
  title = plainOf(ensureTitleNumber(title, priceText, modelPost.blocks.filter((b) => b.kind === 'heading').length));
  const disclosure = getConnectDisclosure(kind === 'travel' ? 'travel' : 'shopping');
  const linkText = kind === 'travel' ? '상품 일정·가격 확인하기' : '상품 가격·옵션 확인하기';
  // inline: 문서 끝 링크 카드로 옮기지 않고 제자리에 클릭 가능한 버튼(표 셀 링크)으로 넣는다.
  const link = () => ({ kind: 'link', text: linkText, href: issuedUrl, btn: true, inline: true, color: '#eaf6ef' });
  const usableAssets = assets.slice(0, 8).map((asset, index) => ({ id: String(asset.id || `img-${index + 1}`), path: asset.path, caption: cleanModelText(asset.caption || productTitle || '상품 이미지') }));
  const maxImages = Math.min(usableAssets.length, 6); let imageCount = 0;
  const blocks = [{ kind: 'text', text: disclosure, _disclosure: true }]; let introLinkAdded = false; let middleLinkAdded = false;
  const headingTotal = modelPost.blocks.filter((b) => b.kind === 'heading').length; let headingSeen = 0;
  for (const block of modelPost.blocks) {
    if (block.kind === 'image') {
      if (imageCount < maxImages) {
        blocks.push({ kind: 'image', assetId: usableAssets[imageCount++].id });
        if (block.caption) blocks.push({ kind: 'text', text: wrapPlain(block.caption), html: '<span style="color:#8b95a5;">' + linesToHtml(wrapSentence(plainOf(block.caption))).html + '</span>' });
      }
      continue;
    }
    if (block.kind === 'heading') {
      headingSeen += 1;
      // 본문 중간(소제목 절반 지점) 링크 한 번 — 처음·중간·끝 총 3회.
      if (introLinkAdded && !middleLinkAdded && headingTotal >= 3 && headingSeen === Math.ceil(headingTotal / 2) + 1) { blocks.push(link()); middleLinkAdded = true; }
      blocks.push({ kind: 'heading', text: plainOf(block.text) });
      continue;
    }
    if (block.kind === 'summary') {
      if (!block.items.length) continue;
      blocks.push(summaryBlock(block));
      if (!introLinkAdded) { blocks.push(link()); introLinkAdded = true; }
      continue;
    }
    if (block.kind === 'text') { if (block.text) blocks.push(...formatTextBlocks(block.text)); continue; }
    if (block.kind === 'qna') { blocks.push({ kind: 'qna', question: plainOf(block.question), answer: wrapPlain(block.answer) }); continue; }
    if (block.kind === 'table') { blocks.push({ ...block, caption: plainOf(block.caption), columns: block.columns.map(plainOf), rows: block.rows.map((row) => row.map(plainOf)) }); continue; }
  }
  if (!introLinkAdded) {
    const firstHeading = blocks.findIndex((b) => b.kind === 'heading');
    blocks.splice(firstHeading > 0 ? firstHeading : Math.min(blocks.length, 2), 0, link());
  }
  const targetImageCount = Math.min(usableAssets.length, 3);
  while (imageCount < targetImageCount) {
    const imageBlock = { kind: 'image', assetId: usableAssets[imageCount++].id };
    const headingIndex = blocks.map((block) => block.kind).lastIndexOf('heading');
    const firstLinkIndex = blocks.findIndex((block) => block.kind === 'link');
    blocks.splice(headingIndex >= 1 ? headingIndex + 1 : firstLinkIndex >= 0 ? firstLinkIndex + 1 : Math.min(blocks.length, 2), 0, imageBlock);
  }
  blocks.push(link()); return { post: { title, blocks }, assets: usableAssets.slice(0, imageCount) };
}
// 페이지 본문에서 상단 메뉴·로그인 문구 같은 잡문을 걷어내 토큰을 줄인다.
function cleanPageText(summary, title = '', max = 4000) {
  let text = String(summary || '').replace(/\s+/g, ' ').trim();
  const anchor = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 15);
  const at = anchor.length >= 6 ? text.indexOf(anchor) : -1;
  if (at > 0 && at < text.length * 0.5) text = text.slice(at);
  text = text.replace(/(로그인|마이페이지|더보기|공유하기|찜하기|장바구니|고객센터)(\s+\1)+/g, '$1');
  return text.slice(0, max);
}
function buildKeywordPrompt(product) {
  return `상품 페이지 자료를 보고 네이버에서 실제 검색할 만한 한국어 검색어 3개를 제안하세요. 2~4어절로, 목적지/상품 종류/특징을 포함하고 브랜드명만 쓰거나 전체 상품명을 그대로 쓰지 마세요. 구매 직전 사람이 찾을 만한 검색어(가격·일정·후기 대신 비교·추천 의도)를 우선합니다. 이유는 40자 이내로 씁니다. 페이지에 없는 사실은 만들지 마세요. JSON만 출력하세요: {"keywords":[{"keyword":"...","reason":"..."}]}\n\n상품명: ${product.title}\n가격 표시: ${product.priceText || '없음'}\n페이지 내용:\n${cleanPageText(product.summary, product.title, 1500)}`;
}
function buildWriterPrompt({ product, keyword, images = [], issuedUrl } = {}) {
  const imageSlots = Math.min(images.length, 6);
  return [
    '네이버 블로그에서 이 상품이 팔리도록 돕는 추천 글을 한국어 존댓말로 쓰세요. 휴대폰으로 읽는 사람이 첫 화면에서 계속 읽을지 결정합니다.',
    '',
    '[규칙]',
    '- 아래 페이지 자료에 있는 사실만 씁니다. 없는 혜택·마감·후기는 만들지 않습니다. 가격은 작성 시점 기준이며 바뀔 수 있다고 한 번 알립니다.',
    '- "다녀왔어요", "써봤는데" 같은 1인칭 체험 표현은 쓰지 않습니다. 과장("역대급", "무조건")도 쓰지 않습니다.',
    '- 문장은 짧게(한 문장 40자 안팎) 씁니다. 줄바꿈과 정렬은 앱이 처리하니 문장만 쓰세요.',
    '- 구매 결정에 꼭 필요한 문장 5~7곳을 ==이렇게== 감싸 강조합니다. 소제목 하나에 최대 1곳입니다.',
    '- 본문 분량은 공백 포함 1,500~2,300자입니다. URL은 쓰지 않습니다.',
    '',
    '[제목]',
    `- "${keyword}"를 포함하고 숫자를 1개 이상 넣습니다(가격, 일정 1박 2일, 핵심 N가지 등). 25~40자, 궁금증이 생기게 씁니다.`,
    '',
    '[블록 순서]',
    '1. text: 후킹 2~3문장. 검색한 사람의 상황이나 질문을 바로 짚고 숫자를 하나 넣습니다(예: "부산에서 1박 2일, 22만 원대로 온천까지 가능할까요?").',
    '2. summary: title "한눈에 보기", items 4~5개(가격, 일정·구성, 포함 사항, 이런 분께 추천 등 각 25자 이내).',
    `3. 소제목(heading) 4~5개와 각 아래 text 1~2개. 이미지 블록 총 ${imageSlots}개를 첫 소제목 앞과 소제목 뒤에 나눠 두고, 각 이미지에 caption(무엇을 보면 되는지 20자 이내)을 씁니다.`,
    '4. summary: title "이런 분께 맞아요 / 아쉬울 수 있어요", items 4개(맞는 사람 2개, 아쉬울 수 있는 점 2개, 페이지 사실 기반).',
    '5. 사실이 충분하면 table 1개(핵심 조건 비교·요약).',
    '6. qna 3개: 취소·추가 비용·일정/배송 등 구매를 망설이게 하는 질문 위주.',
    '7. text: 마무리 2문장. 상세 조건은 아래 링크에서 확인하라고 안내합니다.',
    '',
    'JSON만 출력합니다: {"title":"...","blocks":[{"kind":"text","text":"..."},{"kind":"summary","title":"...","items":["..."]},{"kind":"heading","text":"..."},{"kind":"image","caption":"..."},{"kind":"table","caption":"...","columns":["..."],"rows":[["..."]]},{"kind":"qna","question":"...","answer":"..."}]}',
    '',
    `검색 키워드: ${keyword}`,
    `상품명: ${product.title}`,
    `판매처: ${product.siteName}`,
    `가격 표시: ${product.priceText || '페이지에서 확인되지 않음'}`,
    '페이지 자료:',
    cleanPageText(product.summary, product.title),
  ].join('\n');
}
module.exports = { LAYOUT, stripCodeFence, parseJsonObject, fallbackKeywords, parseKeywordsResponse, detectKind, cleanModelText, normalizeModelPost, formatTextBlocks, wrapSentence, ensureTitleNumber, cleanPageText, assemblePost, buildKeywordPrompt, buildWriterPrompt };
