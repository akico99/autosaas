'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const root = path.join(__dirname, '..', '..');
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8' };
const files = {
  '/app/connect-ui-fixture.html': 'scripts/tests/fixtures/connect-ui.html',
  '/app/travel-connect.html': 'app/travel-connect.html',
  '/app/travel-connect.css': 'app/travel-connect.css',
  '/app/travel-connect.js': 'app/travel-connect.js',
  '/src/connect/policy.js': 'src/connect/policy.js',
  '/src/topics/publishPlan.js': 'src/topics/publishPlan.js',
  '/src/topics/editorGuard.js': 'src/topics/editorGuard.js',
  '/src/topics/editorDelivery.js': 'src/topics/editorDelivery.js',
  '/src/topics/travelConnect.js': 'src/topics/travelConnect.js',
};
async function main(){
  const server=http.createServer((req,res)=>{const relative=files[new URL(req.url,'http://localhost').pathname];if(!relative){res.writeHead(404);res.end('missing');return;}const file=path.join(root,relative);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});if(relative==='scripts/tests/fixtures/connect-ui.html'){const appHtml=fs.readFileSync(path.join(root,'app/app.html'),'utf8');const appCss=appHtml.match(/<style>([\s\S]*?)<\/style>/)[1];res.end(fs.readFileSync(file,'utf8').replace('</head>','<style>'+appCss+'</style></head>'));}else fs.createReadStream(file).pipe(res);});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'travel-connect-electron-'));
  const mainJs=`const {app,BrowserWindow,session}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'user-data'));app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,cb)=>{const u=new URL(d.url);cb({cancel:!(u.hostname==='127.0.0.1'||u.hostname==='localhost'||u.protocol==='data:'||u.protocol==='file:')});});const w=new BrowserWindow({show:false,width:1280,height:980,webPreferences:{nodeIntegration:true,contextIsolation:false}});w.loadURL('http://127.0.0.1:${port}/app/connect-ui-fixture.html');});`;
  fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify({name:'travel-connect-offline-fixture',version:'1.0.0',main:'main.js'}));
  fs.writeFileSync(path.join(temp,'main.js'),mainJs);
  const screenshots=path.join(root,'.superpowers','sdd','2026-10-07-travel-connect-tab-plan','screenshots');fs.mkdirSync(screenshots,{recursive:true});
  let electronApp;
  try{
    const electronEnv={...process.env};
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    delete electronEnv.NODE_OPTIONS;
    Object.assign(electronEnv,{ELECTRON_DISABLE_SECURITY_WARNINGS:'true'});
    electronApp=await _electron.launch({args:[temp],cwd:temp,env:electronEnv,timeout:20000});
    const page=await electronApp.firstWindow();
    const pageErrors=[];page.on('pageerror',(error)=>pageErrors.push(error.message));
    await page.waitForSelector('#topic-travel-tab');
    await page.locator('#topic-travel-tab').click();
    await page.waitForFunction(()=>{const e=document.getElementById('tc-pane');return e&&getComputedStyle(e).display!=='none';});
    await page.waitForSelector('#tc-quick-card');
    assert.equal(await page.locator('#tc-advanced').evaluate(el=>el.open),false,'detailed registration starts collapsed');
    assert.equal(await page.locator('#tc-quick-save').isChecked(),true,'quick flow saves to Naver by default');
    await page.locator('#tc-quick-url').fill('https://naver.me/fixture');await page.locator('#tc-quick-analyze').click();
    await page.waitForFunction(()=>document.querySelectorAll('#tc-quick-keywords .tc-quick-keyword').length===3);
    await page.locator('#tc-quick-keywords .tc-quick-keyword').first().click();
    await page.waitForFunction(()=>window.fixtureCalls.quickGenerate===1&&window.fixtureCalls.quickDeliver===1&&window.fixtureCalls.quickMark===1);
    assert.equal(await page.evaluate(()=>window.fixtureCalls.quickMarkDraftId),'quick-draft-1','the saved draft id is passed through the preload bridge');
    assert.match(await page.locator('#tc-quick-status').innerText(),/네이버 임시저장 완료/,'quick flow reports the confirmed save');
    await page.locator('#tc-advanced').evaluate(el=>{el.open=true;});
    await page.waitForSelector('.tc-product');
    // Match the live app's constrained flex layout, rather than a full-height standalone panel.
    const appWindow=await electronApp.browserWindow(page);
    for(const [width,height] of [[1120,780],[900,640]]){
      await appWindow.evaluate((win,size)=>win.setContentSize(size[0],size[1]),[width,height]);
      const metrics=await page.evaluate(()=>{
        const pane=document.getElementById('tc-pane'),panel=document.getElementById('right-panel');
        return {viewport:window.innerHeight,paneHeight:pane.clientHeight,contentHeight:pane.scrollHeight,paneBottom:pane.getBoundingClientRect().bottom,panelBottom:panel.getBoundingClientRect().bottom};
      });
      assert.ok(metrics.paneHeight>0&&metrics.paneHeight<metrics.contentHeight,'travel pane must have its own scroll range: '+JSON.stringify(metrics));
      assert.ok(metrics.paneBottom<=metrics.viewport+0.01&&metrics.panelBottom<=metrics.viewport+0.01,'sidebar must remain within the window: '+JSON.stringify(metrics));
      const navBefore=await page.locator('#topic-nav').boundingBox();
      const paneBox=await page.locator('#tc-pane').boundingBox();
      await page.mouse.move(paneBox.x+paneBox.width/2,paneBox.y+Math.min(paneBox.height/2,150));
      await page.mouse.wheel(0,600);
      await page.waitForFunction(()=>document.getElementById('tc-pane').scrollTop>0);
      assert.equal(await page.locator('#topic-nav').evaluate(el=>el.getBoundingClientRect().top),navBefore.y,'navigation stays fixed while scrolling');
      assert.equal(await page.locator('#fixture-editor').evaluate(el=>el.scrollTop),0,'editor does not scroll with the menu');
      await page.locator('#tc-pane').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      await page.locator('#tc-perf-sync').scrollIntoViewIfNeeded();
      const lastButton=await page.locator('#tc-perf-sync').boundingBox();
      assert.ok(lastButton&&lastButton.y>=0&&lastButton.y+lastButton.height<=height,'bottom performance controls must be reachable');
      await page.locator('#tc-pane').evaluate(el=>{el.scrollTop=0;});
    }
    await appWindow.evaluate(win=>win.setContentSize(1280,980));
    assert.match(await page.locator('#tc-products').innerText(),/오사카 교토 나라를 여유롭게 둘러보는 4박 5일 가족 맞춤 여행 패키지/);
    await page.locator('[data-tc-product]').nth(0).check();await page.locator('[data-tc-product]').nth(1).check();
    await page.locator('[data-tc-variant]').nth(0).check();await page.locator('[data-tc-variant]').nth(1).check();
    assert.equal(await page.locator('#tc-comparison tbody tr').count(),2);
    assert.match(await page.locator('#tc-comparison').innerText(),/1,290,000원/);
    await page.locator('#tc-pane').screenshot({path:path.join(screenshots,'travel-connect-comparison.png')});
    await page.locator('[data-tc-edit-variant="pkg1"][data-tc-variant-id="pkg1-v2"]').click();
    assert.equal(await page.locator('#tc-register [name="priceWon"]').inputValue(),'1490000');
    assert.equal(await page.locator('#tc-register [name="priceCheckedAt"]').inputValue(),'2026-11-08T09:00');
    await page.locator('#tc-register [name="confirmChecked"]').check();await page.locator('#tc-register [name="confirmRefresh"]').check();
    await page.locator('#tc-register button[type="submit"]').click();
    await page.waitForFunction(()=>window.fixtureCalls.lastSaved!==null);
    const savedVariants=await page.evaluate(()=>window.fixtureCalls.lastSaved.variants);
    assert.equal(savedVariants.find((v)=>v.id==='pkg1-v1').priceCheckedAt,'2026-11-07T00:00:00.000Z');
    assert.notEqual(savedVariants.find((v)=>v.id==='pkg1-v2').priceCheckedAt,'2026-11-08T00:00:00.000Z');
    const savedV1PriceFact=await page.evaluate(()=>window.fixtureCalls.lastSaved.facts.find((f)=>f.field==='variant:pkg1-v1:price'));
    assert.deepEqual(savedV1PriceFact,{field:'variant:pkg1-v1:price',value:1290000,sourceId:'source1',excerpt:'1,290,000원',status:'verified',checkedAt:'2026-11-07T00:00:00.000Z'});
    const importCallsBeforeMismatch=await page.evaluate(()=>window.fixtureCalls.importCalls.length);
    await page.locator('#tc-import-url').fill('https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101');
    await page.locator('#tc-import-product').click();
    assert.match(await page.locator('#tc-import-status').innerText(),/다른 상품 URL은 새 상품으로 등록/);
    assert.equal(await page.evaluate(()=>window.fixtureCalls.importCalls.length),importCallsBeforeMismatch,'a different product URL is blocked before import while editing');
    await page.locator('#tc-register-cancel').click();await page.locator('#tc-toggle-register').click();
    const hanoiUrl='https://pkgtour.naver.com/products/verygoodtour/APP7579%7CWE35-20261103';
    const tsushimaUrl='https://pkgtour.naver.com/products/ybtour/JCP40960000-20261101';
    await page.locator('#tc-import-url').fill(hanoiUrl);await page.locator('#tc-import-product').click();
    await page.waitForSelector('[data-tc-import-variant]');
    assert.equal(await page.evaluate(()=>window.fixtureCalls.importCalls.at(-1).url),hanoiUrl,'the typed product URL is the import request');
    const hanoiReview=await page.locator('#tc-import-review').innerText();
    assert.match(hanoiReview,/참좋은여행/);
    assert.match(hanoiReview,/2026-11-03/);
    assert.match(hanoiReview,/499,000원/,'the observed base fare is retained');
    assert.match(hanoiReview,/474,050원/,'the conditional coupon fare is shown separately');
    assert.match(hanoiReview,/기본 아동 요금/);
    assert.match(hanoiReview,/기본 유아 요금/);
    assert.match(hanoiReview,/23,702P/);
    assert.match(hanoiReview,/5% 쿠폰/);
    assert.match(hanoiReview,/베트남 하롱베이 · 3박 5일/);
    await page.locator('#tc-import-review').screenshot({path:path.join(screenshots,'travel-product-import.png')});
    assert.equal(await page.locator('#tc-register [name="destination"]').inputValue(),'베트남 하롱베이');
    assert.equal(await page.locator('#tc-register [name="days"]').inputValue(),'5');
    assert.equal(await page.locator('#tc-register [name="nights"]').inputValue(),'3');
    assert.equal(await page.locator('[data-tc-import-variant]').count(),1,'the departure-specific URL offers its own option');
    assert.equal(await page.locator('#tc-register .tc-evidence').isHidden(),true,'import evidence does not ask the user to paste excerpts again');
    await page.locator('[data-tc-import-variant]').check();
    await page.locator('#tc-import-save').click();
    assert.match(await page.locator('#tc-register-status').innerText(),/원문과 표시된 옵션별 근거를 확인/,'the UI asks for one source confirmation');
    await page.locator('#tc-register [name="cancellationPolicy"]').fill('출발 30일 전 취소 가능');
    await page.locator('#tc-import-source-confirm').check();await page.locator('#tc-import-save').click();
    await page.waitForFunction(()=>window.fixtureCalls.lastSaved&&window.fixtureCalls.lastSaved.name==='베트남 하롱베이 3박 5일 패키지');
    const importedSave=await page.evaluate(()=>({product:window.fixtureCalls.lastSaved,sources:window.fixtureCalls.lastSaveSources}));
    assert.deepEqual(importedSave.product.variants.map(v=>[v.id,v.amountMinor,v.departureDate,v.priceCheckedAt]),[
      ['halong-20261103',499000,'2026-11-03','2026-10-08T02:30:00.000Z'],
    ]);
    assert.deepEqual(importedSave.product.facts.map(f=>[f.field,f.value,f.sourceId,f.status]),[
      ['variant:halong-20261103:price',499000,'import-source','verified'],
      ['variant:halong-20261103:childPrice',499000,'import-source','verified'],
      ['variant:halong-20261103:infantPrice',100000,'import-source','verified'],
      ['variant:halong-20261103:couponPrice',474050,'import-source','verified'],
      ['variant:halong-20261103:points',23702,'import-source','verified'],
    ]);
    assert.equal(importedSave.product.affiliateUrlRaw,'');
    assert.equal(importedSave.product.eligibility,'unknown');
    assert.equal(importedSave.sources[0].collectedAt,'2026-10-08T02:30:00.000Z');
    assert.equal(importedSave.sources[0].excerpt,'베트남 하롱베이 3박 5일 2026년 11월 3일 출발. 성인 기본가 499,000원, 아동 기본가 499,000원, 유아 기본가 100,000원. 5% 쿠폰 적용가 474,050원. 적립 예정 포인트 23,702P.');
    await page.locator('#tc-register-cancel').click();await page.locator('#tc-toggle-register').click();
    await page.evaluate(()=>{window.fixtureCalls.importDelay=true;});
    await page.locator('#tc-import-url').fill(hanoiUrl);await page.locator('#tc-import-product').click();
    await page.waitForFunction(()=>window.fixtureCalls.resolveImport!==null);
    await page.locator('#tc-import-url').fill(tsushimaUrl);
    await page.locator('#tc-product-details').evaluate(el=>{el.open=true;});
    await page.locator('#tc-register [name="name"]').fill('사용자가 입력한 이름');
    await page.evaluate(()=>{window.fixtureCalls.resolveImport();window.fixtureCalls.importDelay=false;});
    await page.waitForFunction(()=>!document.getElementById('tc-import-product').disabled);
    assert.equal(await page.locator('#tc-register [name="name"]').inputValue(),'사용자가 입력한 이름');
    assert.equal(await page.locator('#tc-import-review').isVisible(),false,'a delayed response for the previous URL is discarded');
    await page.evaluate(()=>{window.fixtureCalls.importFailure=true;});
    await page.locator('#tc-import-product').click();
    await page.waitForFunction(()=>document.getElementById('tc-import-status').innerText.includes('가져오기 실패'));
    assert.equal(await page.locator('#tc-import-product').isDisabled(),false,'failed import can be retried');
    await page.evaluate(()=>{
      window.fixtureCalls.importFailure=false;window.fixtureCalls.importDelay=true;
      const original=window.travelConnectUI.withTravelProductImportTimeout;
      window.fixtureCalls.restoreImportTimeout=()=>{window.travelConnectUI.withTravelProductImportTimeout=original;};
      window.travelConnectUI.withTravelProductImportTimeout=(operation)=>original(operation,10);
    });
    await page.locator('#tc-import-product').click();
    await page.waitForFunction(()=>document.getElementById('tc-import-status').innerText.includes('시간 초과'));
    assert.equal(await page.locator('#tc-import-product').isDisabled(),false,'timed-out import can be retried');
    await page.evaluate(()=>{window.fixtureCalls.restoreImportTimeout();window.fixtureCalls.importDelay=false;window.fixtureCalls.resolveImport=null;});
    await page.locator('#tc-import-product').click();
    await page.waitForSelector('[data-tc-import-variant]');
    const tsushimaReview=await page.locator('#tc-import-review').innerText();
    assert.match(tsushimaReview,/노랑풍선/);
    assert.match(tsushimaReview,/일본 대마도/);
    assert.match(tsushimaReview,/1박 2일/);
    assert.match(tsushimaReview,/2026-11-01/);
    assert.match(tsushimaReview,/229,000원/,'the Tsushima base fare remains distinct');
    assert.match(tsushimaReview,/222,130원/,'the 3% conditional coupon fare remains distinct');
    assert.match(tsushimaReview,/50,000원/);
    assert.match(tsushimaReview,/3% 쿠폰/);
    assert.match(tsushimaReview,/수수료 · 3%/);
    assert.equal(await page.locator('#tc-register [name="destination"]').inputValue(),'일본 대마도');
    assert.equal(await page.locator('#tc-register [name="days"]').inputValue(),'2');
    assert.equal(await page.locator('#tc-register [name="nights"]').inputValue(),'1');
    assert.equal(await page.locator('#tc-register [name="name"]').inputValue(),'사용자가 입력한 이름','successful import also preserves manual edits');
    assert.equal(await page.locator('#tc-register .tc-evidence').isHidden(),true);
    const manualFallbackUrl='https://pkgtour.naver.com/products/example/manual-fallback';
    await page.locator('#tc-import-url').fill(manualFallbackUrl);
    await page.locator('#tc-import-product').click();
    await page.waitForSelector('#tc-import-manual-continue');
    const missingPriceReview=await page.locator('#tc-import-review').innerText();
    assert.match(missingPriceReview,/가격·옵션·가격 확인 시각을 입력해 직접 등록/);
    assert.equal(await page.locator('[data-tc-import-variant]').count(),0);
    await page.locator('#tc-import-manual-continue').click();
    assert.equal(await page.locator('#tc-import-review').isVisible(),false);
    assert.equal(await page.locator('#tc-import-source-confirm-row').isVisible(),false);
    assert.equal(await page.locator('#tc-register button[type="submit"]').isHidden(),false);
    assert.equal(await page.locator('#tc-register .tc-evidence').isVisible(),true);
    assert.equal(await page.locator('#tc-register [name="name"]').inputValue(),'사용자가 입력한 이름');
    assert.equal(await page.locator('#tc-register [name="sourceUrl"]').inputValue(),manualFallbackUrl);
    assert.match(await page.locator('#tc-register [name="sourceExcerpt"]').inputValue(),/성인 기본가 499,000원/);
    await page.locator('#tc-register [name="priceWon"]').fill('499000');
    await page.locator('#tc-register [name="optionName"]').fill('2026-11-03 출발');
    await page.locator('#tc-register [name="priceCheckedAt"]').fill('2026-10-08T12:00');
    await page.locator('#tc-register button[type="submit"]').click();
    await page.waitForFunction(()=>window.fixtureCalls.lastSaved&&window.fixtureCalls.lastSaved.name==='사용자가 입력한 이름');
    const manualSave=await page.evaluate(()=>({product:window.fixtureCalls.lastSaved,sources:window.fixtureCalls.lastSaveSources}));
    assert.deepEqual(manualSave.product.variants.map(v=>[v.amountMinor,v.options,v.priceCheckedAt]),[[499000,['2026-11-03 출발'],'2026-10-08T03:00:00.000Z']]);
    assert.equal(manualSave.sources[0].collectedAt,'2026-10-08T02:30:00.000Z','manual continuation retains original import collection time');
    assert.match(manualSave.sources[0].excerpt,/성인 기본가 499,000원/,'manual continuation retains the imported source excerpt');
    await page.evaluate(()=>{window.fixtureCalls.lastSaveSources[0].collectedAt='2026-10-09T02:30:00.000Z';});
    await page.locator('#tc-register-cancel').click();
    await page.locator('[data-tc-edit-product="fixture-imported-product"]').click();
    await page.locator('#tc-import-url').fill(manualFallbackUrl);await page.locator('#tc-import-product').click();
    await page.waitForSelector('#tc-import-manual-continue');
    await page.locator('#tc-import-manual-continue').click();
    await page.locator('#tc-register button[type="submit"]').click();
    await page.waitForFunction(()=>window.fixtureCalls.lastSaveSources&&window.fixtureCalls.lastSaveSources[0].collectedAt==='2026-10-08T02:30:00.000Z');
    assert.equal(await page.evaluate(()=>window.fixtureCalls.lastSaveSources[0].collectedAt),'2026-10-08T02:30:00.000Z','matching imported collection time wins over a later timestamp on the existing source');
    await page.locator('#tc-keywords').click();
    await page.waitForFunction(()=>document.getElementById('tc-keyword-results').innerText.includes('검색광고 확인 실패'));
    await page.locator('#tc-keywords').click();
    await page.waitForFunction(()=>document.getElementById('tc-keyword-results').innerText.includes('검색광고 XLSX, 자동완성'));
    await page.locator('#tc-keyword-results [data-tc-use-keyword]').click();
    assert.equal(await page.locator('#tc-generate-keyword').inputValue(),'오사카 가족 여행');
    await page.locator('#tc-generate').click();
    await page.waitForFunction(()=>document.getElementById('tc-generation-status').innerText.includes('offline model fixture failure'));
    assert.equal(await page.locator('#tc-generate').isDisabled(),false);
    const review=page.locator('.tc-draft[data-id="review-1"]');
    await review.locator('[data-tc-act="edit"]').click();
    const editor=review.locator('textarea');assert.match(await editor.inputValue(),/\| 상품 \| 가격 \|/);
    await editor.fill((await editor.inputValue())+'\n수정한 비교 설명');await review.locator('[data-tc-act="save"]').click();
    await page.waitForFunction(()=>window.fixtureCalls.updates===1);
    page.on('dialog',(dialog)=>dialog.accept());
    const hold=page.locator('.tc-draft[data-id="hold-1"]');
    await hold.locator('[data-tc-act="deliver"]').click();
    assert.match(await page.locator('#tc-generation-status').innerText(),/보류 원고는 에디터에 넣을 수 없습니다/);
    assert.equal(await page.evaluate(()=>window.fixtureCalls.deliver),0);
    await review.locator('[data-tc-act="deliver"]').click();
    await page.waitForFunction(()=>window.fixtureCalls.mark===1);
    assert.equal(await page.evaluate(()=>window.fixtureCalls.deliver),1);
    await page.locator('#topic-legacy-tab').click();
    await page.waitForFunction(()=>getComputedStyle(document.getElementById('tc-pane')).display==='none'&&getComputedStyle(document.getElementById('legacy-group')).display==='block');
    await page.locator('#topic-travel-tab').click();
    await page.waitForFunction(()=>getComputedStyle(document.getElementById('tc-pane')).display!=='none');
    assert.deepEqual(pageErrors,[]);
    await page.locator('#tc-pane').screenshot({path:path.join(screenshots,'travel-connect-drafts.png')});
    console.log(JSON.stringify({ok:true,screenshots:[path.join(screenshots,'travel-connect-comparison.png'),path.join(screenshots,'travel-connect-drafts.png'),path.join(screenshots,'travel-product-import.png')],checked:['combined classic-script load','real app CSS and flex layout at 1120x780 and 900x640','fixed navigation and bottom controls reachable within floating-point tolerance','travel/legacy tab transition','long Korean product name','multi-option comparison','option-specific edit/price refresh with sibling option and facts preserved','KST datetime-local prefill','URL-first Hanoi import with separate base, coupon, child, infant and points evidence','populated import review screenshot','single source confirmation and import-to-save with source excerpt and collection time','unknown eligibility and blank affiliate URL preserved on import','cross-product URL rejected before import and URL mismatch rejected on save','missing-price import continues through manual price and option entry while retaining source/time','matching manual import time wins over an existing source timestamp','stale import discarded without overwriting manual values','import failure and timeout recover with retry enabled','Tsushima import uses its own departure date, base fare and coupon fare','keyword failure and source provenance','generation button recovery after rejected IPC','draft edit/save','hold gate','explicit review delivery','offline/no external browser requests']}));
  }finally{
    if(electronApp)await electronApp.close();
    await new Promise((resolve)=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch((error)=>{console.error(error);process.exitCode=1;});
