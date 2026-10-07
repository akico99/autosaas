// ★팩트 대조 — 다 쓴 글이 "우리가 준 근거 안에 있는 사실만 썼는지" 되짚는다.
//
// 왜 필요한가:
//   프롬프트는 "지어내지 마라"를 수십 번 말하지만, 그건 지시일 뿐 검사가 아니다.
//   기존 검증(validatePost)은 분량·소제목 수·금칙어·JSON 구조만 본다 —
//   "없는 날짜·수치·소속·발언을 지어냈는지"는 아무도 안 봤다.
//
// 어떻게:
//   완성된 본문에서 "확인 가능한 구체 주장"(날짜·수치·고유명사·발언)만 뽑아
//   제공한 근거(기사 본문·뉴스 제목·배경)와 대조시킨다. 값싼 모델(haiku)로 한 번.
//
// 무엇을 하지 않는가:
//   - 자동으로 글을 고치지 않는다(모델이 고치다 더 틀릴 수 있다).
//   - 근거 밖이라고 무조건 거짓은 아니다(널리 알려진 상식일 수 있다) → "확인 불가"로 표시하고
//     최종 판단은 사람이 한다. 그래서 결과는 경고이지 차단이 아니다.

const { runClaude } = require('./runClaude');
const { isValidHttpUrl, isValidUserSource, isInstitutionPage, isArticleBody, meaningfulText, collectOriginalSources, isConnectSourceType, isConnectProductSource, connectSourceLabel } = require('./searchBrief');

const SYSTEM = [
  '너는 블로그 원고의 사실 검증기다. 원고와 확인된 원문을 받아, 원고 안의 검증 가능한 주장이 원문에 있는지 대조한다.',
  '검색 요약·제목·발췌·후기는 원문이 아니며 어떤 주장도 supported로 만들 수 없다. 배경 파악용으로만 읽는다.',
  '',
  '[검사 대상 — 이런 것만 본다]',
  '- 날짜·기간·시각 (예: "9월 17일 개봉", "3년 만에")',
  '- 수치 (금액·나이·횟수·순위·스코어·비율)',
  '- 고유명사 (인명·작품명·소속팀·기관명·제품명·지명)',
  '- 발언·인용 ("~라고 말했다")',
  '- 인과·확정 표현 ("~때문에 무산됐다", "~로 확정됐다")',
  '',
  '[검사하지 않는 것]',
  '- 의견·감상·비유·수사 ("놀랍다", "눈길을 끈다")',
  '- 일반론·상식 설명 (특정 사건 주장이 아닌 것)',
  '- 독자를 향한 안내 문구·맺음말·해시태그',
  '',
  '[판정]',
  '- supported : 근거에 그대로 있음',
  '- unsupported : 근거에 없음. 근거와 어긋나는 것도 여기(더 위험하므로 severity=high)',
  '- unverifiable : 근거엔 없지만 널리 알려진 상식일 수 있어 단정하기 어려움',
  '',
  '[severity]',
  '- high : 틀리면 글 전체 신뢰가 무너짐 (날짜·수치·인명·소속·발언·확정 표현)',
  '- low : 틀려도 가벼움 (분위기 묘사에 가까운 것)',
  '',
  '반드시 JSON만 출력한다. 설명·코드펜스 금지.',
  '{"claims":[{"text":"원고에서 그대로 인용한 문장(80자 이내)","verdict":"supported|unsupported|unverifiable","severity":"high|low","why":"한 줄 사유"}]}',
  '- supported 는 목록에 넣지 않는다(문제만 보고). 검사할 주장이 없거나 전부 근거에 있으면 {"claims":[]}.',
].join('\n');

/** 블록 배열 → 검사용 본문 텍스트. structured면 표와 Q&A 문장도 포함한다(제휴 상품 글). */
function structuredBlockText(b) {
  if (b.kind === 'table') {
    return [b.columns || [], ...(b.rows || [])]
      .map((row) => (Array.isArray(row) ? row : []).map((cell) => String(cell == null ? '' : cell).trim()).join(' | '))
      .filter((row) => row.replace(/[|\s]/g, '')).join('\n');
  }
  if (b.kind === 'qna') {
    return [b.question && '질문: ' + String(b.question).trim(), b.answer && '답변: ' + String(b.answer).trim()].filter(Boolean).join('\n');
  }
  return '';
}

function blocksToText(blocks, { structured = false } = {}) {
  return (blocks || [])
    .filter((b) => b && (b.kind === 'text' || b.kind === 'heading' || b.kind === 'quote' || (structured && (b.kind === 'table' || b.kind === 'qna'))))
    .map((b) => (b.kind === 'table' || b.kind === 'qna') ? structuredBlockText(b) : String(b.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

/** 관대한 JSON 파싱 — 모델이 코드펜스나 잡문을 붙여도 건진다. */
function parseLoose(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) {} }
  return null;
}

/**
 * 완성된 글을 근거와 대조한다.
 * @param {object} p
 * @param {object} p.post              생성된 글 {title, blocks}
 * @param {string[]} [p.facts]         뉴스 제목+스니펫
 * @param {Array}  [p.articles]        기사 본문 [{title, body}]
 * @param {string[]} [p.background]    인물 배경
 * @param {string[]} [p.placeReviews]  후기 스니펫
 * @param {string} [p.model]           기본 haiku(값싸고 충분)
 * @returns {Promise<{ran:boolean, issues:Array, highCount:number, reason?:string}>}
 */
function isOriginalFactSource(source) {
  // 제휴 상품 출처는 검토된 짧은 발췌일 수 있어 전용 검사기로만 판정한다.
  if (source && typeof source === 'object' && isConnectSourceType(source.sourceType)) return isConnectProductSource(source);
  if (!source || typeof source !== 'object' || !isValidHttpUrl(source.url)
    || !meaningfulText(source.text || source.body)) return false;
  const sourceType = String(source.sourceType || '').toLowerCase();
  if (sourceType === 'user-source') return isValidUserSource(source);
  if (sourceType === 'institution-page') return isInstitutionPage(source);
  if (sourceType === 'news-article') return isArticleBody(source);
  return false;
}

async function factCheckPost({ post, facts, articles, background, placeReviews, officialFacts, originalSources, includeStructured = false, run, model = 'claude-haiku-4-5-20251001' } = {}) {
  const body = blocksToText(post && post.blocks, { structured: includeStructured === true });
  if (!body || body.length < 200) return { ran: false, issues: [], highCount: 0, reason: '본문이 짧아 생략' };

  const ev = [];
  const declaredOriginals = Array.isArray(originalSources) ? originalSources : [];
  const derivedOriginals = collectOriginalSources({ officialFacts });
  const verifiedArticleIndexes = new Set();
  const articleSidecar = Array.isArray(articles && articles.sources) ? articles.sources : [];
  if (Array.isArray(articles)) {
    articles.forEach((article, index) => {
      const single = [article];
      if (articleSidecar[index]) single.sources = [articleSidecar[index]];
      const articleOriginals = collectOriginalSources({ newsArticles: single });
      articleOriginals.forEach((source) => derivedOriginals.push(source));
      if (articleOriginals.some((source) => source.sourceType === 'news-article')) verifiedArticleIndexes.add(index);
    });
  }
  const originals = [...declaredOriginals, ...derivedOriginals]
    .filter(isOriginalFactSource)
    .filter((source, index, all) => all.findIndex((candidate) => candidate.sourceType === source.sourceType && candidate.url === source.url) === index);
  const hasConnectSources = originals.some((source) => isConnectSourceType(source.sourceType));
  if (originals.length) {
    ev.push('[확인된 원문 — 아래 URL과 실제 본문만 확인 근거로 사용]');
    originals.slice(0, 8).forEach((source) => {
      const label = isConnectSourceType(source.sourceType) ? connectSourceLabel(source)
        : source.sourceType === 'institution-page' ? '기관 원문'
        : source.sourceType === 'user-source' ? '사용자 제공 원문' : '기사 원문';
      ev.push(`◆ ${label}${source.title ? '(' + String(source.title).slice(0, 80) + ')' : ''} (${source.url}): ${String(source.text || source.body || '').slice(0, 1800)}`);
    });
  }
  if (Array.isArray(articles) && articles.length) {
    const unverifiedArticles = articles.filter((article, index) => !verifiedArticleIndexes.has(index));
    if (unverifiedArticles.length) {
      ev.push('[수집된 기사 텍스트 — 출처 URL이 확인되지 않아 원문 근거가 아님]');
      unverifiedArticles.slice(0, 3).forEach((a, i) => ev.push(`◆ 자료 ${i + 1}${a.title ? '(' + String(a.title).slice(0, 50) + ')' : ''}: ${String(a.body || '').slice(0, 900)}`));
    }
  }
  if (Array.isArray(facts) && facts.length) {
    ev.push('[검색 제목·요약 — 원문 근거가 아님]');
    facts.slice(0, 20).forEach((f) => ev.push(`· ${f}`));
  }
  if (Array.isArray(background) && background.length) {
    ev.push('[배경 참고 자료 — 원문 근거가 아님]');
    background.slice(0, 15).forEach((b) => ev.push(`· ${b}`));
  }
  if (Array.isArray(placeReviews) && placeReviews.length) {
    ev.push('[후기 발췌 — 원문 근거가 아님]');
    placeReviews.slice(0, 10).forEach((r) => ev.push(`· ${r}`));
  }
  // 근거가 아예 없으면 대조할 게 없다(자동 키워드·리뷰형 등) → 검사 생략.
  if (!ev.length) return { ran: false, issues: [], highCount: 0, reason: '대조할 근거 없음' };

  const user = [
    '[근거 자료 — 확인된 원문과 탐색용 발췌를 구분해서 검토한다]',
    '원문 본문에 있는 사실만 supported로 판정한다. 요약·제목·발췌·후기만 뒷받침하는 주장은 supported로 판정하지 않는다.',
    ...(hasConnectSources
      ? ['상품의 가격·출발일·포함/불포함·취소/환불·변경 조건은 등록 상품 근거로만 supported로 판정한다. 기사·검색 발췌·후기가 같은 내용을 말해도 상품 조건의 근거가 아니다.']
      : []),
    ev.join('\n'),
    officialFacts && String(officialFacts.brief || '').trim()
      ? `\n[탐색용 검색 요약 — 원문 아님]\n${String(officialFacts.brief).slice(0, 1000)}`
      : '',
    '',
    '[검사할 원고]',
    `제목: ${(post && post.title) || ''}`,
    body.slice(0, 6000),
  ].join('\n');

  try {
    const runner = typeof run === 'function' ? run : (args) => runClaude(args);
    const { text } = await runner({ system: SYSTEM, user, model });
    const parsed = parseLoose(text);
    const claims = (parsed && Array.isArray(parsed.claims)) ? parsed.claims : [];
    const issues = claims
      .filter((c) => c && c.verdict && c.verdict !== 'supported')
      .map((c) => ({
        text: String(c.text || '').slice(0, 120),
        verdict: c.verdict === 'unsupported' ? 'unsupported' : 'unverifiable',
        severity: c.severity === 'high' ? 'high' : 'low',
        why: String(c.why || '').slice(0, 120),
      }));
    const highCount = issues.filter((i) => i.verdict === 'unsupported' && i.severity === 'high').length;
    return { ran: true, issues, highCount };
  } catch (e) {
    // 검사 실패가 생성을 막으면 안 된다 — 조용히 넘기되 이유는 남긴다.
    return { ran: false, issues: [], highCount: 0, reason: e.message };
  }
}

module.exports = { factCheckPost, blocksToText, parseLoose, isOriginalFactSource };
