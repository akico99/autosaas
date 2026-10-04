const { runClaude } = require('./runClaude');
const { parseLoose } = require('./factCheck');

const MODEL = 'claude-haiku-4-5-20251001';
const SYSTEM = [
  '너는 검색용 블로그 원고의 필수 답변 검수기다.',
  '각 requiredAnswers 항목이 원고에서 구체적으로 답해졌는지 판단한다.',
  'covered는 해당 내용이 구체적으로 답해졌을 때만 true. 키워드 반복·일반론은 false.',
  "'(해당 시)'가 붙은 항목은 원고 주제에 해당하지 않으면 covered=true, note='해당 없음'으로 처리한다.",
  '각 항목에 id, covered(boolean), blocks(해당 블록 번호 배열), note(한 줄)를 넣는다.',
  '블록 번호는 제공된 번호를 그대로 쓴다. 출력은 아래 JSON 외의 설명이나 코드펜스 없이 JSON만 출력한다.',
  '{"items":[{"id":"answer-id","covered":true,"blocks":[1],"note":"구체적으로 답함"}]}',
].join('\n');

function blockText(block) {
  if (!block) return '';
  if (block.kind === 'text' || block.kind === 'heading' || block.kind === 'quote') {
    return String(block.text || '').trim();
  }
  if (block.kind === 'table') {
    const rows = [block.columns || [], ...(block.rows || [])];
    return rows.map((row) => (Array.isArray(row) ? row : []).map((cell) => String(cell || '')).join(' | ')).filter(Boolean).join('\n');
  }
  if (block.kind === 'qna') {
    const question = String(block.question || '').trim();
    const answer = String(block.answer || '').trim();
    return [question && `질문: ${question}`, answer && `답변: ${answer}`].filter(Boolean).join('\n');
  }
  return '';
}

function collectBlocks(post) {
  return (post && Array.isArray(post.blocks) ? post.blocks : [])
    .map((block, index) => ({ number: index + 1, text: blockText(block) }))
    .filter((block) => block.text);
}

function responseItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed.items)) return parsed.items;
  if (Array.isArray(parsed.answers)) return parsed.answers;
  return null;
}

async function checkRequiredAnswers({ post, brief, run } = {}) {
  const required = Array.isArray(brief && brief.requiredAnswers) ? brief.requiredAnswers : [];
  const blocks = collectBlocks(post);
  const numbered = blocks.map((block) => `[블록 ${block.number}] ${block.text}`).join('\n\n');
  const user = [
    '[원고]',
    `제목: ${String(post && post.title || '')}`,
    numbered || '(본문 블록 없음)',
    '',
    '[필수 답변 항목]',
    ...required.map((item, index) => `${index + 1}. id=${item.id} / ${item.label}`),
  ].join('\n');

  try {
    const runner = typeof run === 'function'
      ? run
      : (args) => runClaude(args);
    const result = await runner({ system: SYSTEM, user, model: MODEL });
    const parsed = parseLoose(result && result.text);
    const rawItems = responseItems(parsed);
    if (!rawItems) throw new Error('내용 검사 JSON 형식을 읽지 못함');

    const byId = new Map();
    rawItems.forEach((item) => {
      if (item && item.id != null) byId.set(String(item.id), item);
    });
    const items = required.map((item) => {
      const found = byId.get(String(item.id));
      return {
        id: String(item.id),
        covered: !!(found && found.covered === true),
        blocks: found && Array.isArray(found.blocks)
          ? found.blocks.filter((number) => Number.isInteger(number) && number >= 1)
          : [],
        note: String(found && found.note || '').replace(/[\r\n]+/g, ' ').slice(0, 120),
      };
    });
    const missing = items
      .filter((item) => !item.covered)
      .map((item) => {
        const definition = required.find((candidate) => String(candidate.id) === item.id);
        return { id: item.id, label: String(definition && definition.label || item.id) };
      });
    return { ran: true, items, missing };
  } catch (error) {
    return { ran: false, items: [], missing: [], reason: String(error && error.message || error) };
  }
}

const EXPERIENCE_CLAIM = /(?:제가|저는|저도|직접|실제로)\s*(?:가\s*보|가\s*봤|다녀|방문해|먹어\s*보|먹어\s*봤|써\s*보|써\s*봤|사용해\s*보|사용해\s*봤|구매해|사\s*봤|사서|타\s*봤|타\s*보|해\s*보니|해\s*봤|입어\s*보|발라\s*보)|내돈내산|직접\s*(?:방문|구매|사용|시술|체험)/g;

function findClaims(text, blockIndex, results) {
  const source = String(text || '');
  EXPERIENCE_CLAIM.lastIndex = 0;
  let match;
  while ((match = EXPERIENCE_CLAIM.exec(source))) {
    const start = Math.max(0, match.index - 24);
    const end = Math.min(source.length, match.index + match[0].length + 32);
    const excerpt = source.slice(start, end).trim().slice(0, 80);
    results.push({ text: excerpt, blockIndex });
    if (!match[0].length) EXPERIENCE_CLAIM.lastIndex++;
  }
}

function detectExperienceClaims(post) {
  const results = [];
  findClaims(post && post.title, -1, results);
  (post && Array.isArray(post.blocks) ? post.blocks : []).forEach((block, blockIndex) => {
    if (!block) return;
    if (block.kind === 'text' || block.kind === 'quote') findClaims(block.text, blockIndex, results);
    if (block.kind === 'qna') findClaims(`${block.question || ''} ${block.answer || ''}`, blockIndex, results);
  });
  return results;
}

module.exports = { checkRequiredAnswers, detectExperienceClaims };
