import {createHash} from 'node:crypto';
import {HttpError} from './api-context.js';
import type {RunRecord, Store} from './database.js';
import type {Worker} from './worker.js';

export const COLLECTION_SUBMISSION_TTL_MS=24*60*60*1000;
const initialized=new WeakSet<Store>();

export function initializeCollectionSubmissions(store:Store):void{
  if(initialized.has(store))return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS collection_submissions (
      request_key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      submitted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collection_submissions_expiry ON collection_submissions(submitted_at);
    CREATE INDEX IF NOT EXISTS collection_submissions_run ON collection_submissions(run_id);
  `);
  if(!store.db.isTransaction)initialized.add(store);
}

export function submitCollection(store:Store,worker:Worker,shopId:string,productIds?:string[],idempotencyKey?:string):RunRecord{
  const enqueue=()=>{
    const shop=store.getShop(shopId);
    if(!shop?.enabled)throw new HttpError(400,'店铺不存在或已停用');
    if(shop.sessionStatus!=='valid')throw new HttpError(400,'账号需要重新验证');
    return worker.enqueue(shopId,null,productIds);
  };
  if(idempotencyKey===undefined)return enqueue();

  initializeCollectionSubmissions(store);
  // A key is global. Shop identity and the set of selected products define the request.
  const fingerprint=createHash('sha256').update(JSON.stringify([shopId,[...new Set(productIds)].sort()])).digest('hex');
  const submittedAt=Date.now();
  return store.transaction(()=>{
    store.db.prepare(`
      DELETE FROM collection_submissions WHERE request_key IN (
        SELECT s.request_key FROM collection_submissions s JOIN runs r ON r.id=s.run_id
        WHERE s.submitted_at<=?
          AND json_extract(r.payload,'$.status') IN ('success','partial','failed','stopped')
        ORDER BY s.submitted_at LIMIT 100
      )
    `).run(submittedAt-COLLECTION_SUBMISSION_TTL_MS);
    const accepted=store.db.prepare('SELECT fingerprint,run_id FROM collection_submissions WHERE request_key=?').get(idempotencyKey);
    if(accepted){
      if(accepted.fingerprint!==fingerprint)throw new HttpError(409,'采集请求标识已用于不同的店铺或商品');
      return store.getRun(String(accepted.run_id))!;
    }
    const run=enqueue();
    store.db.prepare('INSERT INTO collection_submissions(request_key,fingerprint,run_id,submitted_at) VALUES(?,?,?,?)')
      .run(idempotencyKey,fingerprint,run.id,submittedAt);
    return run;
  });
}
