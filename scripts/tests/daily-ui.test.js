'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {dailyQuotaCounts,summarizeDailyResults}=require('../../app/travel-connect.js');

test('daily helper counts successful posts by kind and summarizes skipped or failed rows',()=>{
  const results=[
    {ok:true,kind:'travel'},
    {ok:false,kind:'travel',skipped:true},
    {ok:true,kind:'shopping'},
    {ok:true,kind:'travel'},
    {ok:false,kind:'shopping',error:'fixture failure'},
  ];
  assert.deepEqual(dailyQuotaCounts(results),{travel:2,shopping:1});
  assert.deepEqual(summarizeDailyResults(results),{total:5,succeeded:3,failed:2,travel:2,shopping:1});
});

test('daily helper accepts empty or missing results',()=>{
  assert.deepEqual(dailyQuotaCounts(),{travel:0,shopping:0});
  assert.deepEqual(summarizeDailyResults(null),{total:0,succeeded:0,failed:0,travel:0,shopping:0});
});
