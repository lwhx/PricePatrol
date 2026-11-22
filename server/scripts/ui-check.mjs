import {chromium} from 'playwright';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const base=process.env.BASE_URL||'http://127.0.0.1:3100';
const dir=mkdtempSync(join(tmpdir(),'ui-check-'));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1480,height:1000},deviceScaleFactor:1});
const failures=[];
page.on('pageerror',error=>failures.push('pageerror: '+error.message));
page.on('console',message=>{if(message.type()==='error')failures.push('console: '+message.text());});
const results={};
const setupPattern=new RegExp('设置管理员|管理员密码|创建密码|设置密码');
try{
  await page.goto(base,{waitUntil:'networkidle'});
  results.title=await page.title();
  const body=await page.locator('body').innerText();
  results.setupVisible=setupPattern.test(body);
  await page.screenshot({path:join(dir,'01-start.png'),fullPage:true});
  const passwords=page.locator('input[type=password]');
  if(await passwords.count()){
    const value='ui-check-password-9f2';
    for(let index=0;index<await passwords.count();index++)await passwords.nth(index).fill(value);
    const submit=page.locator('button',{hasText:'设置密码并进入'}).first();
    if(await submit.count())await submit.click();
    else await page.locator('button').last().click();
    await page.waitForTimeout(2500);
  }
  results.afterAuthUrl=page.url();
  results.afterAuthBody=(await page.locator('body').innerText()).slice(0,260);
  results.authenticated=!/设置管理员|管理员密码|创建密码/.test(results.afterAuthBody);
  await page.screenshot({path:join(dir,'02-after-auth.png'),fullPage:true});
  const navs={shops:'店铺账号',prices:'商品价格',tasks:'监控任务',alerts:'预警记录',settings:'系统设置'};
  results.nav={};
  for(const [route,label] of Object.entries(navs)){
    await page.goto(base+'/'+route,{waitUntil:'networkidle'});
    await page.waitForTimeout(900);
    const text=await page.locator('body').innerText();
    results.nav[route]={label,url:page.url(),textLength:text.length,excerpt:text.replace(/\s+/g,' ').slice(0,140)};
    await page.screenshot({path:join(dir,'03-'+route+'.png'),fullPage:true});
  }
  results.failures=failures;
}finally{
  await browser.close();
  console.log(JSON.stringify({dir,results},null,2));
}
