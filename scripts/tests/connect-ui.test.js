'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTravelConnectController, validatePreparedHandoff, mergeTravelVariants, recheckPreparedHandoff, formatSeoulDateTimeInput, parseSeoulDateTimeInput, shouldFetchRelatedLinks } = require('../../src/topics/travelConnect');

test('travel generation callback stays attached to travel state after user changes tabs', async () => {
  let resolveGeneration;
  const calls = [];
  const api = { generateTopic: () => new Promise((resolve) => { resolveGeneration = resolve; }) };
  const controller = createTravelConnectController({ api });
  const pending = controller.generate({ keyword: '부산 가족 여행', productIds: ['p1'], variantIds: ['v1'] });
  controller.setActiveTab('legacy');
  resolveGeneration({ ok: true, draftId: 'd1', status: 'review', post: { title: '부산 가족 여행' } });
  await pending;
  assert.equal(controller.getState().activeTab, 'legacy');
  assert.equal(controller.getState().lastResult.draftId, 'd1');
  assert.equal(calls.length, 0);
});

test('handoff requires exact disclosure and raw affiliate URL bytes in final text', () => {
  const prepared = { connectKind: 'travel', affiliateUrls: ['https://example.test/go?a=1&a=2+3#x', 'https://second.test/r'], allowedUrls: ['https://example.test/go?a=1&a=2+3#x', 'https://second.test/r', 'https://source.test/p'], disclosure: '정확한 여행 고지' };
  assert.equal(validatePreparedHandoff('제목\n정확한 여행 고지\nhttps://example.test/go?a=1&a=2+3#x\nhttps://second.test/r', prepared).ok, true);
  assert.equal(validatePreparedHandoff('제목\n정확한 여행 고지\nhttps://example.test/go?a=1&a=2 3#x\nhttps://second.test/r', prepared).ok, false);
  assert.equal(validatePreparedHandoff('제목\n정확한 여행 고지\nhttps://example.test/go?a=1&a=2+3#x&track=1\nhttps://second.test/r', prepared).ok, false);
  assert.equal(validatePreparedHandoff({ title: '비교', blocks: [{ kind: 'table', columns: ['상품','링크'], rows: [['여행','https://example.test/go?a=1&a=2+3#x'], ['다른 상품','https://second.test/r']], }, { kind: 'text', text: '정확한 여행 고지' }] }, prepared).ok, true);
  assert.equal(validatePreparedHandoff({ title: '비교', blocks: [{ kind: 'table', columns: ['상품','링크'], rows: [['여행','https://example.test/go?a=1&a=2+3#x&track=1'], ['다른 상품','https://second.test/r']], }, { kind: 'text', text: '정확한 여행 고지' }] }, prepared).ok, false);
  assert.equal(validatePreparedHandoff('제목\nhttps://example.test/go?a=1&a=2+3#x', prepared).ok, false);
  assert.equal(validatePreparedHandoff('제목\n정확한 여행 고지\nhttps://example.test/go?a=1&a=2+3#x\nhttps://second.test/r\nhttps://unknown.test/', prepared).ok, false);
});

test('final handoff gate rechecks by saved draft id and rejects a changed or newly held draft', async () => {
  const raw='https://travel.example.test/go?a=1&a=2+3#room';
  const post={title:'비교',blocks:[{kind:'text',text:'정확한 여행 고지'},{kind:'link',href:raw,text:'상품'}]};
  const context={connectKind:'travel',disclosureLine:'정확한 여행 고지',links:[{affiliateUrlRaw:raw}],productSnapshots:[],sources:[]};
  let request;
  const api={connectPrepareDelivery:async(input)=>{request=input;return {ok:true,status:'review',reviewReasons:['확인 필요'],draft:{result:{connect:context}},result:{post,connect:context}};}};
  const valid=await recheckPreparedHandoff({api,id:'saved-1',expectedPost:post,finalPost:post});
  assert.equal(valid.ok,true);assert.deepEqual(request,{id:'saved-1'});
  const edited=await recheckPreparedHandoff({api,id:'saved-1',expectedPost:{title:'stale'},finalPost:post});
  assert.equal(edited.ok,false);assert.match(edited.reason,/수정/);
  api.connectPrepareDelivery=async()=>({ok:false,status:'hold',holdReasons:['가격 확인이 오래되었습니다.']});
  const held=await recheckPreparedHandoff({api,id:'saved-1',expectedPost:post,finalPost:post});
  assert.equal(held.ok,false);assert.match(held.reason,/가격 확인/);
});

test('option edits can refresh a selected sibling without changing the other option timestamp', () => {
  const original=[{id:'v1',priceCheckedAt:'2026-10-07T08:00:00.000Z',amountMinor:129000},{id:'v2',priceCheckedAt:'2026-10-07T08:00:00.000Z',amountMinor:149000}];
  const selected=original.find((v)=>v.id==='v2');
  const saved=mergeTravelVariants(original,{...selected,amountMinor:159000,priceCheckedAt:'2026-10-08T00:00:00.000Z'},{refreshConfirmed:true});
  assert.equal(saved.find((v)=>v.id==='v1').priceCheckedAt,original[0].priceCheckedAt);
  assert.equal(saved.find((v)=>v.id==='v2').priceCheckedAt,'2026-10-08T00:00:00.000Z');
});

test('price timestamps round-trip through Asia/Seoul datetime-local values', () => {
  assert.equal(formatSeoulDateTimeInput('2026-10-08T00:00:00.000Z'),'2026-10-08T09:00');
  assert.equal(parseSeoulDateTimeInput('2026-10-08T09:00'),'2026-10-08T00:00:00.000Z');
});

test('travel handoff omits post-guard related links while legacy kinds retain them', () => {
  assert.equal(shouldFetchRelatedLinks('travel'),false);
  assert.equal(shouldFetchRelatedLinks('shopping'),true);
  assert.equal(shouldFetchRelatedLinks(undefined),true);
});

test('editing a product keeps all variants and does not refresh price time without an explicit recheck', () => {
  const original = [
    { id: 'v1', amountMinor: 129000, priceCheckedAt: '2026-10-07T08:00:00.000Z' },
    { id: 'v2', amountMinor: 149000, priceCheckedAt: '2026-10-07T08:00:00.000Z' },
  ];
  const edited = mergeTravelVariants(original, { id: 'v1', amountMinor: 129000, priceCheckedAt: '2026-10-08T08:00:00.000Z' });
  assert.equal(edited.length, 2);
  assert.equal(edited.find((v) => v.id === 'v1').priceCheckedAt, '2026-10-07T08:00:00.000Z');
  assert.equal(edited.find((v) => v.id === 'v2').priceCheckedAt, original[1].priceCheckedAt);
  const refreshed = mergeTravelVariants(original, { id: 'v1', amountMinor: 129000, priceCheckedAt: '2026-10-08T08:00:00.000Z' }, { refreshConfirmed: true });
  assert.equal(refreshed.find((v) => v.id === 'v1').priceCheckedAt, '2026-10-08T08:00:00.000Z');
  const added = mergeTravelVariants(original, { id: 'v3', amountMinor: 159000, priceCheckedAt: '2026-10-08T08:00:00.000Z' }, { addVariant: true });
  assert.deepEqual(added.map((v) => v.id), ['v1', 'v2', 'v3']);
});
