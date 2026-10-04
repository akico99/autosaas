'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKeywordReportRequest } = require('../../src/keyword/report-ui');

test('validates and normalizes keyword report IPC request inputs before native dialogs', () => {
  assert.deepEqual(normalizeKeywordReportRequest({ seed: ' 사주 ', count: 50, excludeTerms: '카리나, 타로\n사주24' }), {
    seed: '사주', count: 50, excludeTerms: ['카리나', '타로', '사주24'],
  });
  assert.throws(() => normalizeKeywordReportRequest({ seed: '   ', count: 50 }), /씨앗 키워드/);
  assert.throws(() => normalizeKeywordReportRequest({ seed: '보험', count: 40 }), /30, 50, 100/);
  assert.throws(() => normalizeKeywordReportRequest({ seed: '보험', count: 30, excludeTerms: ['x'.repeat(81)] }), /제외어/);
  assert.throws(() => normalizeKeywordReportRequest({ seed: '보험\n', count: 30 }), /씨앗 키워드/);
});
