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
      assert.ok(metrics.paneBottom<=metrics.viewport&&metrics.panelBottom<=metrics.viewport,'sidebar must remain within the window: '+JSON.stringify(metrics));
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
    console.log(JSON.stringify({ok:true,screenshots:[path.join(screenshots,'travel-connect-comparison.png'),path.join(screenshots,'travel-connect-drafts.png')],checked:['combined classic-script load','real app CSS and flex layout','wheel scrolling at 1120x780 and 900x640','fixed navigation and bottom controls reachable','travel/legacy tab transition','long Korean product name','multi-option comparison','option-specific v2 edit/price refresh with v1 facts preserved','KST datetime-local prefill','keyword failure and source provenance','generation button recovery after rejected IPC','draft edit/save','hold gate','explicit review delivery','offline/no external browser requests']}));
  }finally{
    if(electronApp)await electronApp.close();
    await new Promise((resolve)=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch((error)=>{console.error(error);process.exitCode=1;});
