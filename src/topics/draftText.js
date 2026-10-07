'use strict';

// 원고 텍스트 형식 <-> 앱 원고 구조(post) 변환.
// 사용자가 직접 쓴 원고를 불러오거나, 미리 만든 원고를 텍스트로 고칠 때 쓴다.
//
// 형식(한 줄 = 한 의미, 빈 줄 = 문단 구분):
//   제목: ...            (또는 첫 줄 "# ...", 둘 다 없으면 첫 줄)
//   요약: ...            (선택, description)
//   썸네일: ...          (선택, 대표 이미지 문구)
//   ## 소제목
//   > 인용구
//   [사진] / [사진: compat-1] / [사진: 리포트 화면]
//   | 열1 | 열2 |  (표, 두 번째 줄 |---|---| 는 구분선)
//   Q. 질문 / A. 답
//   ---                (구분선)
//   태그: #사주 #궁합

const IMAGE_RE = /^\[\s*(?:사진|이미지|image)\s*(?::\s*([^\]]*))?\]$/i;
const META_RE = /^(제목|요약|썸네일|태그)\s*[:：]\s*(.*)$/;

function splitCells(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function parseDraftText(input, { knownAssetIds = [] } = {}) {
  const lines = String(input || '').replace(/\r\n?/g, '\n').split('\n');
  const known = new Set(knownAssetIds.map(String));
  const post = { title: '', description: '', thumbnailText: '', hashtags: [], blocks: [] };
  const warnings = [];
  let paragraph = [];
  let firstContentLine = null;
  let pendingQuestion = null;

  const flush = () => {
    if (paragraph.length) post.blocks.push({ kind: 'text', text: paragraph.join(' ').replace(/\s+/g, ' ').trim() });
    paragraph = [];
  };
  const flushQuestion = () => {
    if (pendingQuestion) post.blocks.push({ kind: 'qna', question: pendingQuestion, answer: '' });
    pendingQuestion = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) { flush(); continue; }
    const meta = line.match(META_RE);
    if (meta) {
      flush();
      const key = meta[1];
      const value = meta[2];
      if (key === '제목') post.title = value.trim();
      else if (key === '요약') post.description = value.trim();
      else if (key === '썸네일') post.thumbnailText = value.trim();
      else post.hashtags = value.split(/[\s,]+/).map((tag) => tag.replace(/^#/, '').trim()).filter(Boolean);
      continue;
    }
    const link = line.match(/^\[링크(?::([^\]]*))?\]\s+(https?:\/\/\S+)$/i);
    if (link) {
      flush();
      let text = '';
      if (link[1]) {
        try { text = decodeURIComponent(link[1]); }
        catch (_) { warnings.push(`링크 ${index + 1}행의 표시 이름 인코딩이 올바르지 않습니다.`); }
      }
      post.blocks.push({ kind: 'link', ...(text ? { text } : {}), href: link[2] });
      continue;
    }
    if (/^#\s+/.test(line) && !post.title) { flush(); post.title = line.replace(/^#\s+/, '').trim(); continue; }
    if (/^#{2,}\s+/.test(line)) { flush(); flushQuestion(); post.blocks.push({ kind: 'heading', text: line.replace(/^#{2,}\s+/, '').trim() }); continue; }
    if (/^>\s*/.test(line)) { flush(); post.blocks.push({ kind: 'quote', text: line.replace(/^>\s*/, '').trim() }); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line)) { flush(); post.blocks.push({ kind: 'hr' }); continue; }
    const image = line.match(IMAGE_RE);
    if (image) {
      flush();
      const value = String(image[1] || '').trim();
      if (value && known.has(value)) post.blocks.push({ kind: 'image', assetId: value, imageHint: '' });
      else post.blocks.push({ kind: 'image', imageHint: value });
      continue;
    }
    if (/^Q[.:)]\s*/i.test(line)) { flush(); flushQuestion(); pendingQuestion = line.replace(/^Q[.:)]\s*/i, '').trim(); continue; }
    if (/^A[.:)]\s*/i.test(line) && pendingQuestion) {
      flush();
      post.blocks.push({ kind: 'qna', question: pendingQuestion, answer: line.replace(/^A[.:)]\s*/i, '').trim() });
      pendingQuestion = null;
      continue;
    }
    if (line.startsWith('|')) {
      flush();
      const rows = [];
      let cursor = index;
      while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
        const row = lines[cursor].trim();
        if (!isTableSeparator(row)) rows.push(splitCells(row));
        cursor += 1;
      }
      index = cursor - 1;
      if (rows.length) post.blocks.push({ kind: 'table', caption: '', columns: rows[0], rows: rows.slice(1) });
      continue;
    }
    if (firstContentLine === null && !post.title) { firstContentLine = line; continue; }
    paragraph.push(line);
  }
  flush();
  flushQuestion();

  if (!post.title && firstContentLine) post.title = firstContentLine;
  else if (firstContentLine) post.blocks.unshift({ kind: 'text', text: firstContentLine });
  if (!post.title) warnings.push('제목이 없습니다.');
  if (!post.blocks.some((block) => block.kind === 'text' && block.text)) warnings.push('본문 문단이 없습니다.');
  if (!post.description) {
    const firstText = post.blocks.find((block) => block.kind === 'text' && block.text);
    post.description = firstText ? firstText.text.slice(0, 120) : '';
  }
  if (!post.thumbnailText) post.thumbnailText = post.title.slice(0, 30);
  return { post, warnings };
}

// 사진 표시가 하나도 없으면 앞쪽 소제목 앞에 사진 자리를 넣는다(최대 maxImages).
function ensureImageSlots(post, { maxImages = 4 } = {}) {
  const blocks = Array.isArray(post && post.blocks) ? post.blocks : [];
  if (blocks.some((block) => block && block.kind === 'image')) return post;
  const out = [];
  let added = 0;
  for (const block of blocks) {
    if (block && block.kind === 'heading' && added < maxImages) { out.push({ kind: 'image', imageHint: block.text || '' }); added += 1; }
    out.push(block);
  }
  return Object.assign({}, post, { blocks: out });
}

function postToDraftText(post) {
  const out = [];
  if (post && post.title) out.push('제목: ' + post.title);
  if (post && post.description) out.push('요약: ' + post.description);
  if (post && post.thumbnailText) out.push('썸네일: ' + String(post.thumbnailText).replace(/\n/g, ' '));
  out.push('');
  for (const block of (post && post.blocks) || []) {
    if (!block) continue;
    if (block.kind === 'heading') out.push('## ' + (block.text || ''), '');
    else if (block.kind === 'text') out.push(String(block.text || '').replace(/\n+/g, ' '), '');
    else if (block.kind === 'quote') out.push('> ' + (block.text || ''), '');
    else if (block.kind === 'image') out.push(block.assetId ? '[사진: ' + block.assetId + ']' : (block.imageHint ? '[사진: ' + block.imageHint + ']' : '[사진]'), '');
    else if (block.kind === 'hr') out.push('---', '');
    else if (block.kind === 'qna') out.push('Q. ' + (block.question || ''), 'A. ' + (block.answer || ''), '');
    else if (block.kind === 'link' && /^https?:\/\//i.test(String(block.href || '')) && !/\s/.test(String(block.href || ''))) {
      const label = String(block.text || '');
      out.push(`[링크${label ? ':' + encodeURIComponent(label) : ''}] ${block.href}`, '');
    }
    else if (block.kind === 'table') {
      const columns = Array.isArray(block.columns) ? block.columns : [];
      if (columns.length) {
        out.push('| ' + columns.join(' | ') + ' |', '|' + columns.map(() => '---').join('|') + '|');
        for (const row of block.rows || []) out.push('| ' + (row || []).join(' | ') + ' |');
        out.push('');
      }
    }
  }
  if (post && Array.isArray(post.hashtags) && post.hashtags.length) out.push('태그: ' + post.hashtags.map((tag) => '#' + tag).join(' '));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

module.exports = { parseDraftText, postToDraftText, ensureImageSlots };
