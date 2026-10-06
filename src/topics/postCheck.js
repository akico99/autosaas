'use strict';

function postText(post) {
  const blocks = Array.isArray(post && post.blocks) ? post.blocks : [];
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const values = [block.text, block.content];
    if (block.kind === 'qna') values.push(block.question, block.answer);
    if (block.kind === 'table') values.push(block.caption, block.columns, block.rows);
    return values.flat(Infinity).filter((value) => value != null).map(String).join('\n');
  }).join('\n');
}

function checkTopicPost(post, context = {}) {
  const topic = context.topic || { label: '사주보는 수달', serviceFacts: '' };
  const body = postText(post);
  const allText = `${post && post.title || ''}\n${body}`;
  const reviewReasons = [];
  const holdReasons = [];
  const disclosure = context.disclosureLine || `제가 운영하는 ${topic.label}에서는`;
  if (!body.includes(disclosure)) reviewReasons.push('첫 서비스 언급 지점에 운영자 표시 문장이 없습니다.');
  const brandPattern = new RegExp(topic.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const brandCount = (body.match(brandPattern) || []).length;
  if (brandCount > 2) reviewReasons.push('본문의 서비스명 언급이 2회를 넘습니다.');
  const knownPrices = [...String(topic.serviceFacts || '').matchAll(/\d{1,3}(?:,\d{3})*원/g)].map((match) => match[0]);
  for (const match of body.matchAll(/\d{1,3}(?:,\d{3})*원/g)) {
    if (!knownPrices.includes(match[0])) {
      reviewReasons.push(`확인되지 않은 가격 표현이 있습니다: ${match[0]}`);
      break;
    }
  }
  if (/(?:내돈내산|별점|만족도\s*\d|(?:제|저|나)(?:가|는|도)?\s*(?:직접\s*)?(?:결제|구매|이용|사용)(?:해|했)(?:서|더니|보니|봤)|(?:솔직|실제|이용|사용)\s*후기(?:를|입니다|예요|에요|남겨|올려))/i.test(body)) {
    holdReasons.push('고객인 척하는 경험 표현이 있습니다.');
  }
  if (/적중률|100\s*%|무조건|큰일\s*(?:나|납니다|난다|생겨|생깁니다)/i.test(allText)) holdReasons.push('단정·공포를 조장하는 금지 표현이 있습니다.');
  const status = holdReasons.length ? 'hold' : reviewReasons.length ? 'review' : 'ready';
  return { ok: status === 'ready', status, reviewReasons, holdReasons, reasons: [...reviewReasons, ...holdReasons] };
}

module.exports = { checkTopicPost };
