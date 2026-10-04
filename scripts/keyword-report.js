'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { expandKeywords } = require('../src/keyword/expand');
const {
  mergeKeywordCandidates,
  selectKeywordReportRows,
  readSearchAdsWorkbook,
  buildKeywordReportWorkbook,
} = require('../src/keyword/report');

function parseArgs(argv) {
  const parsed = { seed: '', count: 30, ads: '', out: '', exclude: [] };
  const options = new Set(['--seed', '--count', '--ads', '--out', '--exclude']);
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (!options.has(option)) throw new Error(`알 수 없는 옵션: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} 값이 필요합니다.`);
    index++;
    if (option === '--exclude') {
      parsed.exclude.push(...value.split(/[,，\n]/).map((term) => term.trim()).filter(Boolean));
    } else if (option === '--count') {
      if (!/^\d+$/.test(value) || ![30, 50, 100].includes(Number(value))) {
        throw new Error('--count는 30, 50, 100 중 하나여야 합니다.');
      }
      parsed.count = Number(value);
    } else {
      parsed[{ '--seed': 'seed', '--ads': 'ads', '--out': 'out' }[option]] = value;
    }
  }
  if (!parsed.seed.trim()) throw new Error('--seed 기준 키워드를 입력해 주세요.');
  if (!parsed.out.trim()) throw new Error('--out 저장 경로를 입력해 주세요.');
  parsed.seed = parsed.seed.trim();
  return parsed;
}

async function runReport(options) {
  const importedAt = new Date().toISOString();
  const imported = options.ads
    ? await readSearchAdsWorkbook(options.ads, { importedAt })
    : { rows: [], sourceFileName: '', sourceSheetName: '', importedAt: '' };

  let autocompleteKeywords = [];
  try {
    autocompleteKeywords = await expandKeywords([options.seed], {
      rounds: 1,
      maxCandidates: 120,
      delayMs: 120,
    });
  } catch (error) {
    // Autocomplete is supplemental: keep imported official counts usable if its public endpoint is unavailable.
    process.stderr.write(`자동완성 후보를 가져오지 못했습니다: ${error.message}\n`);
  }

  const candidates = mergeKeywordCandidates(options.seed, imported.rows, autocompleteKeywords);
  const selection = selectKeywordReportRows(candidates, {
    seed: options.seed,
    count: options.count,
    excludeTerms: options.exclude,
  });
  const buffer = await buildKeywordReportWorkbook(selection.rows, {
    seed: options.seed,
    requestedCount: selection.requestedCount,
    importedCount: imported.rows.length,
    sourceFileName: imported.sourceFileName,
    importedAt: imported.importedAt,
    sourceSheetName: imported.sourceSheetName,
    availableCount: selection.availableCount,
    shortfall: selection.shortfall,
    autocompleteEnabled: true,
    excludeTerms: options.exclude,
  });

  const outputPath = path.resolve(options.out);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  return { outputPath, selection, importedCount: imported.rows.length, autocompleteCount: autocompleteKeywords.length };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const result = await runReport(options);
    const categoryCounts = Object.fromEntries(
      [...new Set(result.selection.rows.map((row) => row.category))]
        .map((category) => [category, result.selection.rows.filter((row) => row.category === category).length]),
    );
    process.stdout.write(`${JSON.stringify({
      outputPath: result.outputPath,
      seed: options.seed,
      requestedCount: options.count,
      selectedCount: result.selection.selectedCount,
      availableCount: result.selection.availableCount,
      shortfall: result.selection.shortfall,
      importedCount: result.importedCount,
      autocompleteCount: result.autocompleteCount,
      categoryCounts,
    }, null, 2)}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`키워드 보고서 생성 실패: ${error.message}\n`);
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, runReport, main };
