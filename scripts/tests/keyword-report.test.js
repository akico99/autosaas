'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

function reportModule() {
  try {
    return require('../../src/keyword/report');
  } catch {
    return {};
  }
}

test('parses Search Ads headers after title rows and preserves numeric, censored, and missing counts', () => {
  const { parseSearchAdsRows } = reportModule();
  assert.equal(typeof parseSearchAdsRows, 'function', 'report module should expose parseSearchAdsRows');
  if (typeof parseSearchAdsRows !== 'function') return;

  const result = parseSearchAdsRows([
    ['네이버 검색광고 키워드 도구'],
    ['연관키워드', '월간검색수(PC)', '월간검색수(모바일)', '월간클릭수(PC)', '광고 경쟁정도'],
    ['사주', '12,800', '85,400', '123', '높음'],
    ['무료사주', '4,880', '26,000', '40', '중간'],
    ['저검색량', '<10', '320', '', '낮음'],
    ['검색량없음', '', null, '', '낮음'],
  ], { sourceFileName: 'keywords.xlsx', importedAt: '2026-10-03T00:00:00.000Z' });

  assert.deepEqual(result.rows.slice(0, 3).map((row) => [row.keyword, row.monthlyPc, row.monthlyMobile, row.monthlyTotal]), [
    ['사주', 12800, 85400, 98200],
    ['무료사주', 4880, 26000, 30880],
    ['저검색량', '<10', 320, null],
  ]);
  assert.equal(result.rows[3].monthlyPc, null);
  assert.equal(result.rows[3].monthlyMobile, null);
  assert.equal(result.rows[3].monthlyTotal, null);
  assert.equal(result.sourceFileName, 'keywords.xlsx');
});

test('combines Search Ads keyword and PC/mobile headers spread across two rows', () => {
  const { parseSearchAdsRows } = reportModule();
  assert.equal(typeof parseSearchAdsRows, 'function', 'report module should expose parseSearchAdsRows');
  if (typeof parseSearchAdsRows !== 'function') return;

  const rawRows = [
    ['연관키워드', '월간검색수 ', '', '월평균클릭수 ', '', '월평균클릭률 ', '', '경쟁정도', '월평균노출 광고수'],
    ['', '월간검색수(PC)', '월간검색수(모바일)', '월평균클릭수(PC)', '월평균클릭수(모바일)', '월평균클릭률(PC)', '월평균클릭률(모바일)', '', ''],
    ['사주', '12,800', '85,400', '123', '456', '1.5%', '2.0%', '높음', '10'],
  ];
  let result;
  let parseError;
  try { result = parseSearchAdsRows(rawRows); } catch (error) { parseError = error; }

  assert.equal(parseError, undefined, `two-row headers should parse: ${parseError && parseError.message}`);
  assert.deepEqual(result.rows.map((row) => [row.keyword, row.monthlyPc, row.monthlyMobile, row.monthlyTotal]), [
    ['사주', 12800, 85400, 98200],
  ]);
});

test('merges autocomplete duplicates with imported rows while keeping counts and both provenances', () => {
  const { mergeKeywordCandidates } = reportModule();
  assert.equal(typeof mergeKeywordCandidates, 'function', 'report module should expose mergeKeywordCandidates');
  if (typeof mergeKeywordCandidates !== 'function') return;

  const candidates = mergeKeywordCandidates('사주', [
    { keyword: '무료 사주', monthlyPc: 120, monthlyMobile: 380, monthlyTotal: 500, sources: ['search-ads-xlsx'] },
  ], ['  무료사주  ', 'AI 사주', 'ai사주']);
  const free = candidates.find((row) => row.keywordKey === '무료사주');
  const ai = candidates.find((row) => row.keywordKey === 'ai사주');

  assert.equal(candidates.filter((row) => row.keywordKey === '무료사주').length, 1);
  assert.deepEqual([free.keyword, free.monthlyPc, free.monthlyMobile, free.monthlyTotal], ['무료 사주', 120, 380, 500]);
  assert.deepEqual(free.sources, ['search-ads-xlsx', 'naver-autocomplete']);
  assert.equal(candidates.filter((row) => row.keywordKey === 'ai사주').length, 1);
  assert.deepEqual(ai.sources, ['naver-autocomplete']);
  assert.equal(ai.monthlyPc, null);
});

test('classifies saju service intent and excludes clearly unrelated or stale terms', () => {
  const { classifyKeyword } = reportModule();
  assert.equal(typeof classifyKeyword, 'function', 'report module should expose classifyKeyword');
  if (typeof classifyKeyword !== 'function') return;

  const offer = classifyKeyword('AI 무료 사주 온라인 상담', '사주', { currentYear: 2026 });
  assert.equal(offer.category, '상담·이용');
  for (const intent of ['무료', 'AI', '온라인', '상담']) assert.ok(offer.intents.includes(intent), `expected ${intent} intent`);
  assert.equal(classifyKeyword('서울 사주 철학관', '사주').intents.includes('오프라인/지역'), true);
  assert.equal(classifyKeyword('무료 운세', '사주').relation, 'broad');
  assert.equal(classifyKeyword('일반 운세', '사주').excluded, false);

  assert.match(classifyKeyword('2025년 사주', '사주', { currentYear: 2026 }).excludeReason, /오래된 연도/);
  assert.match(classifyKeyword('무료 타로', '사주').excludeReason, /주제와 무관/);
  assert.equal(classifyKeyword('아이유 사주', '사주').excluded, true);
  assert.match(classifyKeyword('아이유 사주', '사주').reviewNote, /인물/);
  assert.match(classifyKeyword('사주의신', '사주').excludeReason, /브랜드/);
  assert.equal(classifyKeyword('서울 철학관', '사주').excluded, true);
  assert.equal(classifyKeyword('MR 구입', '사주').excluded, true);
  for (const keyword of ['인터넷사주', '온라인사주', '전화사주', '비대면사주', '직업사주', '오행사주', '오늘의운세', '무료사주궁합']) {
    assert.equal(classifyKeyword(keyword, '사주').excluded, false, `${keyword} is a valid related topic`);
  }
  assert.match(classifyKeyword('카리나 전화 사주', '사주').excludeReason, /인물/);
  assert.match(classifyKeyword('카리나전화사주', '사주').excludeReason, /인물/);
  assert.match(classifyKeyword('사주아이유', '사주').excludeReason, /인물/);
  assert.match(classifyKeyword('음식궁합', '사주').excludeReason, /주제와 무관/);
});

test('assigns editorial topic groups from explicit keyword terms and gives generic intent a visible label', () => {
  const { classifyKeyword } = reportModule();
  assert.equal(typeof classifyKeyword, 'function', 'report module should expose classifyKeyword');
  if (typeof classifyKeyword !== 'function') return;

  assert.equal(classifyKeyword('사주궁합', '사주').category, '궁합·관계');
  assert.equal(classifyKeyword('사주 결혼운', '사주').category, '연애·결혼');
  assert.equal(classifyKeyword('사주 직업운', '사주').category, '직업·사업');
  assert.equal(classifyKeyword('사주 재물운', '사주').category, '재물');
  assert.equal(classifyKeyword('사주 오행', '사주').category, '오행·명리 개념');
  assert.equal(classifyKeyword('AI 사주 상담', '사주').category, '상담·이용');
  assert.equal(classifyKeyword('사주풀이', '사주').category, '일반 사주');
  assert.deepEqual(classifyKeyword('사주풀이', '사주').intents, ['일반 탐색']);
  assert.match(classifyKeyword('사주풀이도우미', '사주').reviewNote, /서비스명/);
});

test('classifies non-face-to-face consultations as online without the offline intent', () => {
  const { classifyKeyword } = reportModule();
  assert.equal(typeof classifyKeyword, 'function', 'report module should expose classifyKeyword');
  if (typeof classifyKeyword !== 'function') return;

  const result = classifyKeyword('비대면 사주 상담', '사주');
  assert.ok(result.intents.includes('온라인'));
  assert.ok(result.intents.includes('상담'));
  assert.equal(result.intents.includes('오프라인/지역'), false);
});

test('selects direct and close-related saju terms before much larger broad fortune counts', () => {
  const { mergeKeywordCandidates, selectKeywordReportRows } = reportModule();
  assert.equal(typeof selectKeywordReportRows, 'function', 'report module should expose selectKeywordReportRows');
  if (typeof mergeKeywordCandidates !== 'function' || typeof selectKeywordReportRows !== 'function') return;

  const candidates = mergeKeywordCandidates('사주', [
    { keyword: '사주', monthlyPc: 12800, monthlyMobile: 85400, monthlyTotal: 98200, sources: ['search-ads-xlsx'] },
    { keyword: '무료 사주풀이', monthlyPc: 70, monthlyMobile: 30, monthlyTotal: 100, sources: ['search-ads-xlsx'] },
    { keyword: '명리학 공부', monthlyPc: 8, monthlyMobile: 12, monthlyTotal: 20, sources: ['search-ads-xlsx'] },
    { keyword: '무료 운세', monthlyPc: 800000, monthlyMobile: 900000, monthlyTotal: 1700000, sources: ['search-ads-xlsx'] },
    { keyword: '일반 운세', monthlyPc: 900000, monthlyMobile: 900000, monthlyTotal: 1800000, sources: ['search-ads-xlsx'] },
    { keyword: '2025년 사주', monthlyPc: 2000000, monthlyMobile: 1000000, monthlyTotal: 3000000, sources: ['search-ads-xlsx'] },
    { keyword: '사주24', monthlyPc: 1000000, monthlyMobile: 1000000, monthlyTotal: 2000000, sources: ['search-ads-xlsx'] },
    { keyword: '아이유 사주', monthlyPc: 1000000, monthlyMobile: 1000000, monthlyTotal: 2000000, sources: ['search-ads-xlsx'] },
  ], []);

  const selected = selectKeywordReportRows(candidates, { seed: '사주', count: 30, currentYear: 2026 });
  assert.deepEqual(selected.rows.slice(0, 2).map((row) => row.keyword), ['무료 사주풀이', '명리학 공부']);
  assert.equal(selected.requestedCount, 30);
  assert.equal(selected.availableCount, 4);
  assert.equal(selected.shortfall, 26);
});

test('generic seeds do not automatically admit high-volume terms with no seed phrase', () => {
  const { mergeKeywordCandidates, selectKeywordReportRows } = reportModule();
  const candidates = mergeKeywordCandidates('보험', [
    { keyword: '보험 추천', monthlyPc: 2, monthlyMobile: 3 },
    { keyword: '사주', monthlyPc: 10000, monthlyMobile: 20000 },
  ], []);
  const selected = selectKeywordReportRows(candidates, { seed: '보험', count: 30, currentYear: 2026 });
  assert.deepEqual(selected.rows.map((row) => row.keyword), ['보험 추천']);
  assert.equal(selected.availableCount, 1);
  assert.equal(selected.shortfall, 29);
});

test('reports a real shortfall for each supported selection size without adding seed or filler rows', () => {
  const { mergeKeywordCandidates, selectKeywordReportRows } = reportModule();
  assert.equal(typeof selectKeywordReportRows, 'function', 'report module should expose selectKeywordReportRows');
  if (typeof mergeKeywordCandidates !== 'function' || typeof selectKeywordReportRows !== 'function') return;

  const candidates = mergeKeywordCandidates('사주', [
    { keyword: '사주', monthlyPc: 1, monthlyMobile: 1, monthlyTotal: 2, sources: ['search-ads-xlsx'] },
    { keyword: '사주풀이', monthlyPc: 8, monthlyMobile: 9, monthlyTotal: 17, sources: ['search-ads-xlsx'] },
    { keyword: '명리학', monthlyPc: '<10', monthlyMobile: 10, monthlyTotal: null, sources: ['search-ads-xlsx'] },
    { keyword: '꿈해몽', monthlyPc: 1000, monthlyMobile: 1000, monthlyTotal: 2000, sources: ['search-ads-xlsx'] },
  ], []);

  for (const [count, expectedShortfall] of [[30, 28], [50, 48], [100, 98]]) {
    const result = selectKeywordReportRows(candidates, { seed: '사주', count, currentYear: 2026 });
    assert.equal(result.rows.length, 2);
    assert.equal(result.shortfall, expectedShortfall);
    assert.ok(result.rows.every((row) => row.keyword !== '사주' && row.keyword !== '꿈해몽'));
  }
});

test('allows a user exclusion phrase to remove an ambiguous person or product name', () => {
  const { mergeKeywordCandidates, selectKeywordReportRows } = reportModule();
  assert.equal(typeof selectKeywordReportRows, 'function', 'report module should expose selectKeywordReportRows');
  if (typeof mergeKeywordCandidates !== 'function' || typeof selectKeywordReportRows !== 'function') return;

  const candidates = mergeKeywordCandidates('사주', [
    { keyword: '서예지 사주', monthlyPc: 300, monthlyMobile: 700, sources: ['search-ads-xlsx'] },
    { keyword: '인터넷 사주', monthlyPc: 200, monthlyMobile: 500, sources: ['search-ads-xlsx'] },
  ], []);
  const result = selectKeywordReportRows(candidates, { seed: '사주', count: 30, currentYear: 2026, excludeTerms: ['서예지'] });

  assert.deepEqual(result.rows.map((row) => row.keyword), ['인터넷 사주']);
  assert.equal(result.availableCount, 1);
  assert.equal(result.shortfall, 29);
});

test('imports an actual Search Ads XLSX workbook with its split two-row header', async () => {
  const { readSearchAdsWorkbook } = reportModule();
  assert.equal(typeof readSearchAdsWorkbook, 'function', 'report module should expose readSearchAdsWorkbook');
  if (typeof readSearchAdsWorkbook !== 'function') return;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('연관키워드');
  sheet.addRows([
    ['연관키워드', '월간검색수 ', '', '월평균클릭수 ', '', '월평균클릭률 ', '', '경쟁정도', '월평균노출 광고수'],
    ['', '월간검색수(PC)', '월간검색수(모바일)', '월평균클릭수(PC)', '월평균클릭수(모바일)', '월평균클릭률(PC)', '월평균클릭률(모바일)', '', ''],
    ['사주', '12,800', '85,400', '100', '1,332.8', '0.85%', '1.66%', '높음', '10'],
    ['무료사주', '4,880', '26,000', '40', '300', '0.5%', '1.0%', '중간', '4'],
  ]);
  const filePath = path.join(os.tmpdir(), `keyword-report-import-${process.pid}.xlsx`);
  try {
    await workbook.xlsx.writeFile(filePath);
    const imported = await readSearchAdsWorkbook(filePath, { importedAt: '2026-10-03T00:00:00.000Z' });
    assert.equal(imported.sourceFileName, path.basename(filePath));
    assert.deepEqual(imported.rows.map((row) => [row.keyword, row.monthlyPc, row.monthlyMobile, row.monthlyTotal]), [
      ['사주', 12800, 85400, 98200],
      ['무료사주', 4880, 26000, 30880],
    ]);
    assert.equal(imported.rows[0].sourceRow, 3);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('exports a real XLSX with typed counts, source notes, filters, frozen headers, and Unicode', async () => {
  const { buildKeywordReportWorkbook } = reportModule();
  assert.equal(typeof buildKeywordReportWorkbook, 'function', 'report module should expose buildKeywordReportWorkbook');
  if (typeof buildKeywordReportWorkbook !== 'function') return;

  const buffer = await buildKeywordReportWorkbook([
    { keyword: '사주 풀이', monthlyPc: 12800, monthlyMobile: 85400, monthlyTotal: 98200, category: '사주·명리', intents: ['정보형'], sources: ['search-ads-xlsx'] },
    { keyword: '저검색량', monthlyPc: '<10', monthlyMobile: 20, monthlyTotal: null, category: '관련 키워드', intents: [], sources: ['search-ads-xlsx', 'naver-autocomplete'] },
    { keyword: '검색량 없음', monthlyPc: null, monthlyMobile: null, monthlyTotal: null, category: '관련 키워드', intents: [], sources: ['naver-autocomplete'] },
  ], {
    seed: '사주', requestedCount: 30, importedCount: 511, sourceFileName: 'source.xlsx',
    importedAt: '2026-10-02T16:30:00.000Z', periodLabel: '2026년 10월 다운로드', autocompleteEnabled: true,
  });
  assert.ok(Buffer.isBuffer(buffer));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('연관 키워드');
  assert.ok(sheet);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['키워드', '월간 검색수 (PC)', '월간 검색수 (모바일)', '월간 검색 합계', '분류', '검색 의도', '원본', '검토 메모']);
  assert.equal(sheet.getCell('A2').value, '사주 풀이');
  assert.equal(sheet.getCell('B2').value, 12800);
  assert.equal(sheet.getCell('C2').value, 85400);
  assert.equal(sheet.getCell('D2').value, 98200);
  assert.equal(typeof sheet.getCell('B2').value, 'number');
  assert.equal(sheet.getCell('B3').value, '<10');
  assert.equal(sheet.getCell('D3').value, null);
  assert.equal(sheet.getCell('F2').value, '정보형');
  assert.match(sheet.getCell('G3').value, /네이버 검색광고.*네이버 자동완성/);
  assert.ok(sheet.autoFilter);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(workbook.getWorksheet('안내').getCell('B1').value, '사주');
  assert.equal(workbook.getWorksheet('안내').getCell('B5').value, '2026-10-03');
  assert.equal(workbook.getWorksheet('안내').getCell('B6').value, 'source.xlsx');
});

test('parses CLI options including Windows paths with spaces and repeatable exclusion terms', () => {
  const { parseArgs } = require('../keyword-report');
  assert.equal(typeof parseArgs, 'function', 'CLI should expose parseArgs for predictable option handling');
  const parsed = parseArgs([
    '--seed', '사주', '--count', '100', '--ads', 'C:\\Users\\me\\Downloads\\keyword file.xlsx',
    '--out', 'outputs\\result.xlsx', '--exclude', '카리나, 타로', '--exclude', '사주24',
  ]);
  assert.deepEqual(parsed, {
    seed: '사주', count: 100, ads: 'C:\\Users\\me\\Downloads\\keyword file.xlsx',
    out: 'outputs\\result.xlsx', exclude: ['카리나', '타로', '사주24'],
  });
});

test('CLI option parser rejects invalid counts, missing required options, and unknown flags', () => {
  const { parseArgs } = require('../keyword-report');
  assert.equal(typeof parseArgs, 'function', 'CLI should expose parseArgs for predictable option handling');
  assert.throws(() => parseArgs(['--seed', '사주', '--count', '40', '--out', 'x.xlsx']), /30, 50, 100/);
  assert.throws(() => parseArgs(['--seed', '사주', '--out', 'x.xlsx', '--count']), /값이 필요/);
  assert.throws(() => parseArgs(['--seed', '사주', '--out', 'x.xlsx', '--oops', 'x']), /알 수 없는 옵션/);
  assert.throws(() => parseArgs(['--seed', '사주']), /--out/);
});
