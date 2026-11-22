import {chromium} from 'playwright';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const base=process.env.BASE_URL||'http://127.0.0.1:3110';
const dir=mkdtempSync(join(tmpdir(),'ui-check-'));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1480,height:1000},deviceScaleFactor:1});
const failures=[];
page.on('pageerror',error=>failures.push('pageerror: '+error.message));
page.on('console',message=>{if(message.type()==='error')failures.push('console: '+message.text().slice(0,300));});
const results={};
const password='realkeyboard-pass-42';
try{
  await page.goto(base,{waitUntil:'networkidle'});
  results.title=await page.title();
  const first=page.locator('input[type=password]').nth(0);
  if(await first.count()){
    await first.click();await page.keyboard.type(password,{delay:12});
    if(await page.locator('input[type=password]').count()>1){await page.keyboard.press('Tab');await page.keyboard.type(password,{delay:12});}
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
  }
  results.authenticated=/工作总览/.test(await page.locator('body').innerText());
  await page.screenshot({path:join(dir,'01-overview.png'),fullPage:true});
  const navs={shops:'店铺账号',prices:'商品价格',tasks:'监控任务',alerts:'预警记录',settings:'系统设置'};
  results.nav={};
  for(const [route,label] of Object.entries(navs)){
    await page.goto(base+'/'+route,{waitUntil:'networkidle'});
    await page.waitForTimeout(900);
    const text=await page.locator('body').innerText();
    const orphan=/正在连接管理服务|初始化管理员/.test(text);
    results.nav[route]={label,orphan,textLength:text.length,excerpt:text.replace(/\s+/g,' ').slice(0,150)};
    await page.screenshot({path:join(dir,'02-'+route+'.png'),fullPage:true});
  }
  // Task creation via UI: requires a shop, so assert the empty-state guidance instead of faking data.
  await page.goto(base+'/tasks/new',{waitUntil:'networkidle'});
  await page.waitForTimeout(800);
  results.taskEdit=(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,220);
  await page.screenshot({path:join(dir,'03-task-new.png'),fullPage:true});
  results.failures=failures;
}finally{
  await browser.close();
  console.log(JSON.stringify({dir,results},null,2));
}
