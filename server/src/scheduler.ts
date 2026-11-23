import {Cron} from 'croner';
import type {Schedule} from '../../shared/contracts.js';
import type {Store} from './database.js';
import type {Worker} from './worker.js';
import type {DiagnosticReporter} from './diagnostics.js';
import {hasScheduleEvent,initializeOperations,pruneScheduleEvents,recordScheduleEvent,scheduleRetentionStart} from './operations.js';
export function nextRunAt(schedule:Schedule,after=new Date()):string|null {
  if(schedule.kind==='manual')return null;
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)||schedule.kind==='weekly'&&!schedule.days.length)throw Error('无效定时配置');
  const [hour,minute]=schedule.time.split(':');const days=schedule.kind==='weekly'?[...new Set(schedule.days)].join(','):'*';
  const cron=new Cron(`${minute} ${hour} * * ${days}`,{timezone:schedule.timezone,paused:true});
  try{return cron.nextRun(after)?.toISOString()||null;}finally{cron.stop();}
}
export class Scheduler {
  private timer:ReturnType<typeof setInterval>|null=null;
  constructor(private store:Store,private worker:Worker,private report?:DiagnosticReporter){initializeOperations(store);}
  start():void{if(this.timer)return;this.tick();this.timer=setInterval(()=>this.tick(),15000);this.timer.unref();}
  stop():void{if(this.timer)clearInterval(this.timer);this.timer=null;}
  tick(at=new Date()):void{
    const recordedAt=at.toISOString();
    const cutoff=scheduleRetentionStart(at);
    try{
      for(const task of this.store.listTasks()){
        if(!task.enabled||task.schedule.kind==='manual'||(task.nextRunAt&&task.nextRunAt>recordedAt))continue;
        try{this.store.transaction(()=>this.process(task.id,at,recordedAt,cutoff));}
        catch{this.report?.('schedule_storage_failed',{taskId:task.id});}
      }
      pruneScheduleEvents(this.store,at);
    }catch{this.report?.('schedule_storage_failed');}
  }

  private process(taskId:string,at:Date,recordedAt:string,cutoff:Date):void{
    const task=this.store.getTask(taskId);
    if(!task?.enabled||task.schedule.kind==='manual'||(task.nextRunAt&&task.nextRunAt>recordedAt))return;

    const eventBase={taskId,shopId:task.shopId,recordedAt};
    const due:string[]=[];
    let next:string|null;
    try{
      next=nextRunAt(task.schedule,at);
      if(task.nextRunAt){
        let cursor=task.nextRunAt<cutoff.toISOString() ? nextRunAt(task.schedule,new Date(cutoff.getTime()-1)) : task.nextRunAt;
        // Daily and weekly schedules can have at most 31 due occurrences in the retention window.
        while(cursor&&cursor<=recordedAt&&due.length<31){
          due.push(cursor);
          cursor=nextRunAt(task.schedule,new Date(cursor));
        }
      }
    }catch{
      if(task.nextRunAt&&task.nextRunAt>=cutoff.toISOString()&&recordScheduleEvent(this.store,{...eventBase,scheduledFor:task.nextRunAt,outcome:'failed',reason:'schedule_invalid',runId:null})){
        this.report?.('schedule_invalid',{taskId});
      }
      return;
    }

    const shop=due.length?this.store.getShop(task.shopId):undefined;
    const unavailable=!shop?'shop_missing':!shop.enabled?'shop_disabled':shop.sessionStatus!=='valid'?'account_invalid':null;
    const latest=due.at(-1);
    for(const scheduledFor of due){
      const occurrence={...eventBase,scheduledFor};
      if(unavailable||scheduledFor!==latest){
        recordScheduleEvent(this.store,{...occurrence,outcome:'skipped',reason:unavailable||'missed',runId:null});
        continue;
      }
      if(hasScheduleEvent(this.store,taskId,scheduledFor))continue;
      this.store.db.exec('SAVEPOINT enqueue_schedule');
      let run;
      try{run=this.worker.enqueue(task.shopId,task.id,undefined,true);}
      catch{
        this.store.db.exec('ROLLBACK TO enqueue_schedule; RELEASE enqueue_schedule');
        recordScheduleEvent(this.store,{...occurrence,outcome:'failed',reason:'enqueue_failed',runId:null});
        this.report?.('schedule_enqueue_failed',{taskId});
        continue;
      }
      this.store.db.exec('RELEASE enqueue_schedule');
      recordScheduleEvent(this.store,{...occurrence,outcome:'enqueued',reason:run.mergedSchedules?'merged':'queued',runId:run.id});
    }
    this.store.saveTask({...task,nextRunAt:next});
  }
}
