/** Verifies horizontal table completeness and copy dialog behaviour on real data. */
import {chromium} from 'playwright';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const base=process.env.BASE_URL;
const dir=mkdtempSync(join(tmpdir(),'ui-copy-'));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1560,height:1050}});
const failures=[];
page.on('pageerror',e=>failures.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')failures.push('console: '+m.text().slice(0,200));});
const results={};
try{
  await page.goto(base,{waitUntil:'networkidle'});
  const pw=page.locator('input[type=password]').nth(0);
  if(await pw.count()){await pw.click();await page.keyboard.type('uisxcz-qnhvlerk-73',{delay:8});await page.keyboard.press('Enter');await page.waitForTimeout(2500);}
  await page.goto(base+'/prices',{waitUntil:'networkidle'});await page.waitForTimeout(2200);
  results.table=await page.evaluate(()=>{
    const table=document.querySelector('table');if(!table)return {missing:true};
    const scroller=table.closest('.el-scrollbar__wrap, .el-table__body-wrapper, [class*=scroll]');
    const headers=[...table.querySelectorAll('thead th')].map(th=>th.innerText.trim()).filter(Boolean);
    return {headers,headerCount:headers.length,tableWidth:table.getBoundingClientRect().width,
      containerWidth:table.parentElement.getBoundingClientRect().width,
      scrollWidth:scroller?scroller.scrollWidth:null,clientWidth:scroller?scroller.clientWidth:null,
      bodyScrollWidth:document.body.scrollWidth,windowWidth:window.innerWidth};
  });
  await page.screenshot({path:join(dir,'01-table.png'),fullPage:true});
  // Select two rows through the visible checkboxes, then open the copy dialog.
  const boxes=page.locator('table tbody input[type=checkbox]');
  if(await boxes.count()>=2){await boxes.nth(0).click();await boxes.nth(1).click();}
  results.selected=await page.locator('body').innerText().then(t=>{const m=t.match(/已选\s*(\d+)/);return m?m[1]:null;});
  const copyButton=page.getByRole('button',{name:/复制\s*\/\s*导出/}).nth(1);
  if(await copyButton.count()){await copyButton.click();await page.waitForTimeout(1200);}
  results.dialog=(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(-700);
  await page.screenshot({path:join(dir,'02-copy-dialog.png'),fullPage:true});
  results.failures=failures;
}finally{
  await browser.close();
  console.log(JSON.stringify({dir,results},null,2));
}
