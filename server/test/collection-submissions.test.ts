import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import type {Collector,VerifiedAccount} from '../../shared/contracts.js';
import {HttpError} from '../src/api-context.js';
import {submitCollection} from '../src/collection-submissions.js';
import {Store} from '../src/database.js';
import {Worker} from '../src/worker.js';
import {cleanupRetention} from '../src/retention.js';

const key='a'.repeat(64);
const account:VerifiedAccount={shopName:'测试店铺',sellerId:'seller-a',platform:'tmall',cookies:[{name:'cookie2',value:'fixture'}],userAgent:'fixture',appKey:'123456'};
const collector:Collector={
  verify:async()=>account,
  collect:async()=>({cookies:account.cookies,expected:0,processed:0,failedProductIds:[],coverageComplete:true}),
};
function addShop(store:Store,id:string){
  const at=new Date().toISOString(),credentials={...account,sellerId:`seller-${id}`};
  store.saveShop({id,name:account.shopName,sellerId:credentials.sellerId,platform:credentials.platform,enabled:true,
    sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:true},credentials);
}

it('returns the accepted manual run for the same canonical key after completion and restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'price-patrol-submissions-'));
  const filename=join(dir,'test.sqlite');
  let store=new Store(filename,key),worker=new Worker(store,collector);
  try{
    addShop(store,'a');addShop(store,'b');
    const accepted=submitCollection(store,worker,'a',['100002','100001','100002'],'key-A');
    expect(accepted.trigger).toBe('manual');
    expect(accepted.alertDispatchStatus).toBe('not_applicable');
    await worker.whenIdle();
    await worker.close();store.close();
    store=new Store(filename,key);worker=new Worker(store,collector);

    const replay=submitCollection(store,worker,'a',['100001','100002'],'key-A');
    expect(replay.id).toBe(accepted.id);
    expect(replay.finishedAt).toEqual(expect.any(String));
    expect(()=>submitCollection(store,worker,'a',['100003'],'key-A')).toThrow(HttpError);
    expect(()=>submitCollection(store,worker,'b',['100001','100002'],'key-A')).toThrow(expect.objectContaining({statusCode:409}));
    expect(store.listRuns()).toHaveLength(1);
  }finally{await worker.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

it('expires old completed mappings and preserves an expired mapping while queued',async()=>{
  const store=new Store(':memory:',key),worker=new Worker(store,collector);
  try{
    addShop(store,'a');
    const completed=submitCollection(store,worker,'a',undefined,'completed');
    await worker.whenIdle();
    const queued=submitCollection(store,worker,'a',['100001'],'queued');
    store.db.prepare('UPDATE collection_submissions SET submitted_at=?').run(Date.now()-25*60*60*1000);
    expect(submitCollection(store,worker,'a',['100001'],'queued').id).toBe(queued.id);
    expect(submitCollection(store,worker,'a',undefined,'completed').id).not.toBe(completed.id);
  }finally{await worker.close();store.close();}
});

it('does not persist a run when writing the request mapping fails',async()=>{
  const store=new Store(':memory:',key),worker=new Worker(store,collector);
  try{
    addShop(store,'a');
    const initial=submitCollection(store,worker,'a',undefined,'initial');
    store.db.exec(`CREATE TRIGGER fail_submission BEFORE INSERT ON collection_submissions
      WHEN NEW.request_key='retry' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;`);
    expect(()=>submitCollection(store,worker,'a',undefined,'retry')).toThrow('fixture write failure');
    expect(store.listRuns().map(run=>run.id)).toEqual([initial.id]);
    store.db.exec('DROP TRIGGER fail_submission');
    expect(submitCollection(store,worker,'a',undefined,'retry').id).not.toBe(initial.id);
  }finally{await worker.close();store.close();}
});
it('protects an accepted receipt from both cleanup policies for its entire idempotency window',async()=>{
 const store=new Store(':memory:',key),worker=new Worker(store,collector);
 try{
  addShop(store,'a');const accepted=submitCollection(store,worker,'a',undefined,'recent-receipt');await worker.whenIdle();
  const before=new Date(Date.now()+1000).toISOString();
  expect(store.cleanup(before)).toBe(0);
  expect(cleanupRetention(store,{historyBefore:before,alertBefore:before}).deleted).toBe(0);
  expect(submitCollection(store,worker,'a',undefined,'recent-receipt').id).toBe(accepted.id);
  store.db.prepare('UPDATE collection_submissions SET submitted_at=?').run(Date.now()-25*60*60*1000);
  expect(cleanupRetention(store,{historyBefore:before,alertBefore:before}).deleted).toBe(1);
 }finally{await worker.close();store.close();}
});
