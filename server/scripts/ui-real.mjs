/**
 * Full UI acceptance with the real seller account.
 * Imports current cookies through the packaged API (as the browser UI would),
 * runs a selected-product collection from the UI, then verifies query/copy views.
 */
import {chromium} from 'playwright';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const browserId=process.env.BROWSER_ID;
const base=process.env.BASE_URL||'http://127.0.0.1:3111';
const productIds=(process.env.PRODUCT_IDS||'').split(',').filter(Boolean);
if(!browserId||productIds.length<1)throw Error('需要 BROWSER_ID 与 PRODUCT_IDS');
const sctl=(...args)=>{const out=execFileSync('sctl',[...args,'-o','json'],{encoding:'utf8',maxBuffer:64*1024*1024});return JSON.parse(out);};
const cookies=[];
for(const domain of ['taobao.com','tmall.com']){
  const data=sctl('cookies','list','--browser',browserId,'--domain',domain,'--limit','1000');
  if(data.hasMore)throw Error('cookie export truncated');
  cookies.push(...data.items);
}
const tabs=sctl('tabs','list','--browser',browserId).tabs;
const seller=tabs.find(t=>t.url.includes('qn.taobao.com/home.htm/SellManage/'));
if(!seller)throw Error('请保持千牛商品页打开以取得appKey');
const probe=execFileSync('sctl',['page','eval','--browser',browserId,'--tab',String(seller.tabId),'--timeout','25s','(function(){var r=performance.getEntriesByType("resource").filter(function(e){return e.name.indexOf("/mtop.")!==-1&&e.name.indexOf(".sell.pc.manage.")!==-1});var l=r[r.length-1];return l?new URL(l.name).searchParams.get("appKey"):"";})()'],{encoding:'utf8'});
const appKey=String(JSON.parse(probe.slice(probe.indexOf(':')+1).trim())||'');
const userAgent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const dir=mkdtempSync(join(tmpdir(),'ui-real-'));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1560,height:1050}});
const failures=[];
page.on('pageerror',e=>failures.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')failures.push('console: '+m.text().slice(0,300));});
const results={};
try{
  await page.goto(base,{waitUntil:'networkidle'});
  const pw=page.locator('input[type=password]').nth(0);
  if(await pw.count()){
    await pw.click();await page.keyboard.type('uisxcz-qnhvlerk-73',{delay:10});
    if(await page.locator('input[type=password]').count()>1){await page.keyboard.press('Tab');await page.keyboard.type('uisxcz-qnhvlerk-73',{delay:10});}
    await page.keyboard.press('Enter');await page.waitForTimeout(2500);
  }
  const created=await page.evaluate(async payload=>{
    const response=await fetch('/api/shops',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    return {status:response.status,body:await response.text()};
  },{platform:'tmall',cookies,userAgent,appKey});
  results.shopCreate={status:created.status,body:created.body.slice(0,220)};
  await page.goto(base+'/shops',{waitUntil:'networkidle'});await page.waitForTimeout(1500);
  await page.screenshot({path:join(dir,'01-shops.png'),fullPage:true});
  results.shopList=(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,260);
  const run=await page.evaluate(async ids=>{
    const shops=await (await fetch('/api/shops',{credentials:'include'})).json();
    const shopId=shops.shops[0].id;
    const response=await fetch('/api/shops/'+shopId+'/collect',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({productIds:ids})});
    return {status:response.status,body:await response.text()};
  },productIds);
  results.runStart=run;
  const runId=JSON.parse(run.body).run.id;
  for(let i=0;i<90;i++){
    await page.waitForTimeout(2000);
    const state=await page.evaluate(async id=>{const list=await (await fetch('/api/runs',{credentials:'include'})).json();return list.runs.find(r=>r.id===id)||null;},runId);
    if(state&&['success','partial','failed','auth_required','stopped'].includes(state.status)){results.run=state;break;}
  }
  await page.goto(base+'/prices',{waitUntil:'networkidle'});await page.waitForTimeout(2500);
  const pricesText=(await page.locator('body').innerText()).replace(/\s+/g,' ');
  results.prices={excerpt:pricesText.slice(0,320),hasDiscountColumn:/折扣/.test(pricesText)};
  await page.screenshot({path:join(dir,'02-prices.png'),fullPage:true});
  const tall=await page.locator('body').boundingBox();
  results.pageHeight=tall?.height??0;
  results.failures=failures;
}finally{
  await browser.close();
  console.log(JSON.stringify({dir,results},null,2));
}
