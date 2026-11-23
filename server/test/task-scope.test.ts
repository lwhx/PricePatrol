import {afterEach,expect,it} from 'vitest';
import type {Collector,VerifiedAccount} from '../../shared/contracts.js';
import {buildApp} from '../src/app.js';
import {Store} from '../src/database.js';

const verified:VerifiedAccount={sellerId:'merchant-1',shopName:'测试店铺',platform:'tmall',cookies:[{name:'cookie2',value:'fixture'}],userAgent:'fixture',appKey:'123456'};
const collector:Collector={verify:async()=>verified,collect:async()=>({cookies:verified.cookies,expected:0,processed:0,failedProductIds:[],coverageComplete:true})};
let close:(()=>Promise<void>)|undefined;
afterEach(async()=>{await close?.();close=undefined;});
async function setup(){
  const store=new Store(':memory:','a'.repeat(64));
  const {app}=await buildApp({store,collector,dataDir:'.local/test-data'});
  close=async()=>{await app.close();store.close();};
  const auth=await app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'long-test-password'}});
  expect(auth.statusCode).toBe(200);
  const cookie=auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
  return {app,store,cookie};
}

it('appends to the latest task scope and rejects stale full edits', async () => {
  const {app,cookie,store}=await setup();
  const headers={cookie};
  const shop=(await app.inject({method:'POST',url:'/api/shops',headers,payload:{platform:'tmall',cookies:'cookie2=secret'}})).json().shop;
  const body={shopId:shop.id,name:'指定商品',enabled:true,scope:'selected',productIds:['100001'],schedule:{kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'}};
  const created=(await app.inject({method:'POST',url:'/api/tasks',headers,payload:body})).json().task;
  const url=`/api/tasks/${created.id}`;
  const append=(productIds:string[])=>app.inject({method:'POST',url:`${url}/products`,headers,payload:{productIds}});
  const appends=await Promise.all([append(['100001','100002']),append(['100003'])]);
  expect(appends.map(response=>response.statusCode)).toEqual([200,200]);
  const current=store.getTask(created.id)!;
  expect(current.productIds).toHaveLength(3);
  expect(current.productIds).toEqual(expect.arrayContaining(['100001','100002','100003']));
  expect(current.version).toBe(3);
  expect((await append(['100002'])).json().task.version).toBe(3);

  const stale=await app.inject({method:'PATCH',url,headers,payload:{...body,name:'旧编辑',expectedVersion:created.version}});
  expect(stale.statusCode).toBe(409);
  expect(store.getTask(created.id)).toEqual(current);
  const fresh=await app.inject({method:'PATCH',url,headers,payload:{expectedVersion:current.version,scope:'all',productIds:[]}});
  expect(fresh.statusCode).toBe(200);
  expect(fresh.json().task.version).toBe(4);
  expect((await append(['100004'])).statusCode).toBe(409);
});
