import {randomUUID} from 'node:crypto';
import type {Alert,Collector,MonitorTask,Run,CollectedRow} from '../../shared/contracts.js';
import type {Store,RunRecord} from './database.js';
import {evaluateRules,whitelistReason} from './domain.js';
export type NotifyRun=(run:RunRecord,alerts:Alert[])=>Promise<void>;
const now=()=>new Date().toISOString();
export class Worker {
  private active:AbortController|null=null;
  private activeId:string|null=null;
  private draining:Promise<void>|null=null;
  private closed=false;
  constructor(private store:Store,private collector:Collector,private notify?:NotifyRun){}
  recover():void {for(const run of this.store.listRuns()){let changed=false;if(run.status==='running'||run.status==='queued'){run.status='recoverable';run.message='进程中断，核验账号后可继续';changed=true;}if(run.notificationStatus==='sending'){run.notificationStatus='failed';changed=true;}if(changed)this.store.saveRun(run);}}
  enqueue(shopId:string,taskId:string|null=null,productIds?:string[],scheduled=false):RunRecord {
    const shop=this.store.getShop(shopId);if(!shop?.enabled)throw Error('店铺不存在或已停用');
    if(shop.sessionStatus!=='valid')throw Error('账号需要重新验证');
    const task=taskId?this.store.getTask(taskId):null;
    if(taskId&&(!task||task.shopId!==shopId))throw Error('监控任务不属于该店铺');
    if(taskId){const pending=this.store.listRuns().filter(r=>r.taskId===taskId&&['queued','running'].includes(r.status));
      const queued=pending.find(r=>r.status==='queued');if(queued){if(scheduled){queued.mergedSchedules=(queued.mergedSchedules||0)+1;this.store.saveRun(queued);}return queued;}
      if(pending.length&&!scheduled)return pending[0]!;
    }
    const ids=productIds??(task?.scope==='selected'?task.productIds:[]);
    const run:RunRecord={id:randomUUID(),taskId,shopId,taskName:task?.name||'手动采集',shopName:shop.name,status:'queued',scope:ids.length?'selected':'all',productIds:[...ids],expected:ids.length,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'等待采集',createdAt:now(),startedAt:null,finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:task?.notify?'pending':'disabled',taskSnapshot:task?structuredClone(task):null};
    this.store.saveRun(run);this.kick();return run;
  }
  stop(id:string):RunRecord {
    const run=this.requireRun(id);if(!['running','queued'].includes(run.status))throw Error('只能停止运行或排队的作业');
    if(this.activeId===id)this.active?.abort();
    run.status='stopped';run.message='已停止，可继续';this.store.saveRun(run);return run;
  }
  resume(id:string):RunRecord {
    const run=this.requireRun(id);if(!['stopped','recoverable','auth_required'].includes(run.status))throw Error('该作业不能继续，请重新运行或重试失败项');
    const shop=this.store.getShop(run.shopId);if(!shop?.enabled||shop.sessionStatus!=='valid')throw Error('请先验证店铺登录状态');
    if(this.activeId===id)throw Error('正在结束请求，请稍后继续');
    run.status='queued';run.message='等待继续';run.finishedAt=null;this.store.saveRun(run);this.kick();return run;
  }
  retry(id:string):RunRecord {
    const prior=this.requireRun(id);if(!['success','partial','failed'].includes(prior.status)||!prior.failedProductIds.length)throw Error('没有可重试的失败商品');
    const shop=this.store.getShop(prior.shopId);if(!shop?.enabled||shop.sessionStatus!=='valid')throw Error('请先验证店铺登录状态');
    const existing=this.store.listRuns().find(r=>r.parentRunId===id&&['queued','running'].includes(r.status));if(existing)return existing;
    const run:RunRecord={...structuredClone(prior),id:randomUUID(),status:'queued',scope:'selected',productIds:[...prior.failedProductIds],expected:prior.failedProductIds.length,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'等待重试失败商品',createdAt:now(),startedAt:null,finishedAt:null,parentRunId:id,failedProductIds:[],notificationStatus:'pending'};
    this.store.saveRun(run);this.kick();return run;
  }
  async whenIdle():Promise<void>{while(this.draining)await this.draining;}
  async close():Promise<void>{this.closed=true;this.active?.abort();await this.whenIdle();}
  private requireRun(id:string):RunRecord{const run=this.store.getRun(id);if(!run)throw Error('作业不存在');return run;}
  private kick():void {if(this.closed||this.draining)return;this.draining=Promise.resolve().then(()=>this.drain()).finally(()=>{this.draining=null;});}
  private async drain():Promise<void>{
    while(!this.closed){const run=this.store.listRuns().filter(r=>r.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];if(!run)break;
      try{await this.execute(run);}
      catch(error){
        const current=this.store.getRun(run.id);
        if(current&&!['success','partial','failed'].includes(current.status)){
          current.status='failed';current.finishedAt=now();current.message='采集异常中止，请查看账号状态或重试';
          try{this.store.saveRun(current);}catch{/* 终结报告已存在时保持原记录 */}
        }
        this.active=null;this.activeId=null;
      }
    }
  }
  private completedProducts(id:string):Set<string>{
    const map=new Map<string,boolean>();for(const row of this.store.getRunPrices(id)){map.set(row.productId,(map.get(row.productId)??true)&&row.status==='ok'&&!row.stale);}return new Set([...map].filter(([,ok])=>ok).map(([id])=>id));
  }
  private async execute(run:RunRecord):Promise<void>{
    const controller=new AbortController();this.active=controller;this.activeId=run.id;
    run.status='running';run.startedAt??=now();run.message='正在读取商品';this.store.saveRun(run);
    const completed=this.completedProducts(run.id),failures=new Set<string>();let processed=completed.size;
    try{
      const shop=this.store.getShop(run.shopId);if(!shop?.enabled||shop.sessionStatus!=='valid')throw Object.assign(Error('请先更新登录状态'),{code:'AUTH_REQUIRED'});
      const credentials=this.store.getCredentials(run.shopId);
      const result=await this.collector.collect({shopId:run.shopId,credentials,productIds:run.scope==='selected'?run.productIds:undefined,skipProductIds:[...completed],signal:controller.signal,
        onProgress:progress=>{if(controller.signal.aborted)return;run.expected=Math.max(run.expected,progress.expected);run.message=progress.message;this.store.saveRun(run);},
        onProduct:product=>{if(controller.signal.aborted||completed.has(product.productId))return;this.assertProduct(run,product.rows);this.store.saveProduct(run.id,product);processed++;run.processed=processed;if(product.error)failures.add(product.productId);run.failed=failures.size;run.rows=this.store.getRunPrices(run.id).length;this.store.saveRun(run);}});
      if(controller.signal.aborted){run.status='stopped';run.message='已停止，可继续';return;}
      const currentShop=this.store.getShop(run.shopId);if(currentShop)this.store.saveShop({...currentShop,sessionStatus:'valid',lastError:null,updatedAt:now()},{...credentials,cookies:result.cookies});
      result.failedProductIds.forEach(id=>failures.add(id));run.failedProductIds=[...failures];run.failed=failures.size;run.processed=processed;run.expected=Math.max(run.expected,result.expected);run.status=run.failed||!result.coverageComplete?'partial':'success';run.message=run.status==='success'?'采集完成':'部分完成，请查看失败与覆盖范围';run.finishedAt=now();this.evaluate(run);
    }catch(error){
      if(controller.signal.aborted){run.status='stopped';run.message='已停止，可继续';}
      else if(/AUTH|LOGIN|SESSION|PERMISSION/.test(String((error as {code?:string}).code||''))){run.status='auth_required';run.message='登录失效或权限不足，请更新Cookie并验证后继续';const shop=this.store.getShop(run.shopId);if(shop)this.store.saveShop({...shop,sessionStatus:'auth_required',lastError:run.message,updatedAt:now()});}
      else{run.status='failed';run.finishedAt=now();run.message='采集失败，请查看账号状态或重试';run.failedProductIds=[...failures];if(run.scope==='selected')run.failedProductIds=[...new Set([...run.failedProductIds,...run.productIds.filter(id=>!completed.has(id))])];this.evaluate(run);}
    }finally{
      this.store.saveRun(run);this.active=null;this.activeId=null;
    }
    if(run.finishedAt&&run.taskSnapshot?.notify&&this.notify){try{await this.notify(run,this.store.listAlerts({runId:run.id}));}catch{const saved=this.requireRun(run.id);saved.notificationStatus='failed';this.store.saveRun(saved);}}
  }
  private assertProduct(run:RunRecord,rows:CollectedRow[]):void{
    for(const row of rows)if(row.shopId!==run.shopId||!/^[0-9]{6,20}$/.test(row.productId)||(row.skuId&&!/^[0-9]{6,20}$/.test(row.skuId)))throw Error('采集结果身份校验失败');
  }
  private evaluate(run:RunRecord):void{
    const rows=this.store.getRunPrices(run.id);run.rows=rows.length;run.checked=0;run.excluded=0;run.matched=0;run.unknown=0;
    const task=run.taskSnapshot;if(!task)return;
    for(const row of rows){if(whitelistReason(row,task.whitelist)){run.excluded++;continue;}const result=evaluateRules(row,task.rules);if(result.value===null){run.unknown++;continue;}run.checked++;if(!result.value)continue;run.matched++;
      this.store.saveAlert({id:`${run.id}:${row.id}`,runId:run.id,taskId:run.taskId,shopId:run.shopId,shopName:run.shopName,productId:row.productId,skuId:row.skuId,title:row.title,specs:row.specs,backendPrice:row.backendPrice,before:row.before,after:row.after,discount:row.discount,reasons:result.reasons,state:'pending',note:'',createdAt:now()});}
  }
}
