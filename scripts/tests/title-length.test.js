'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TITLE_MAX, shortenTitle } = require('../../src/generator/titleLength');
const { buildSystemPrompt, buildTitleRefinePrompt } = require('../../src/generator/buildPrompt');
const { checkHomefeedWords } = require('../../src/generator/homefeedWords');

test('long homefeed titles are cut at a meaning boundary and keep the keyword', () => {
  const title = '토익 준비물 시계 하나로 입실 막힐 수 있다던데, 신분증·연필까지 총정리';
  const out = shortenTitle(title, { keyword: '토익 준비물', max: TITLE_MAX.home });
  assert.ok(out.length <= TITLE_MAX.home, out);
  assert.ok(out.startsWith('토익 준비물'));
  assert.ok(!/[,，]$/.test(out));
});

test('shortening keeps a required homefeed word or leaves the title unchanged', () => {
  const title = '대장암 초기증상 자가체크, 방귀 잦고 변 굵기까지 달라졌다면 의심';
  const out = shortenTitle(title, { keyword: '대장암 초기증상', max: 30, accept: (s) => checkHomefeedWords(s).ok });
  assert.ok(checkHomefeedWords(out).ok);
  assert.ok(out.length <= 30 || out === title);
});

test('short titles and titles without a safe cut point are returned as is', () => {
  assert.equal(shortenTitle('무료사주 결과가 다 달랐던 이유', { keyword: '무료사주' }), '무료사주 결과가 다 달랐던 이유');
  const noCut = '무료사주 7곳 돌려봤더니 결과가 다 달라서 결국 3900원 썼다';
  assert.equal(shortenTitle(noCut, { keyword: '무료사주', max: 30 }), noCut);
});

test('legacy prompts state the title length limit and a single hook', () => {
  const refine = buildTitleRefinePrompt({ typeKey: 'life', draft: { title: '긴 제목' }, facts: [] });
  assert.match(refine, /최대 30자/);
  assert.match(refine, /30자 이하인가/);
  assert.match(buildSystemPrompt('life'), /최대 30자/);
  assert.match(buildSystemPrompt('celebrity'), /최대 30자/);
});
