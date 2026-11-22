import {Cron} from 'croner';
import type {Schedule} from '../../shared/contracts.js';
import type {Store} from './database.js';
import type {Worker} from './worker.js';
export function nextRunAt(schedule:Schedule,after=new Date()):string|null {
  if(schedule.kind==='manual')return null;
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)||schedule.kind==='weekly'&&!schedule.days.length)throw Error('无效定时配置');
  const [hour,minute]=schedule.time.split(':');const days=schedule.kind==='weekly'?[...new Set(schedule.days)].join(','):'*';
  const cron=new Cron(`${minute} ${hour} * * ${days}`,{timezone:schedule.timezone,paused:true});
  try{return cron.nextRun(after)?.toISOString()||null;}finally{cron.stop();}
}
export class Scheduler {
  private timer:ReturnType<typeof setInterval>|null=null;
  constructor(private store:Store,private worker:Worker){}
  start():void{if(this.timer)return;this.tick();this.timer=setInterval(()=>this.tick(),15000);this.timer.unref();}
  stop():void{if(this.timer)clearInterval(this.timer);this.timer=null;}
  tick(at=new Date()):void{
    for(const task of this.store.listTasks()){
      if(!task.enabled||task.schedule.kind==='manual')continue;
      if(!task.nextRunAt){task.nextRunAt=nextRunAt(task.schedule,at);this.store.saveTask(task);continue;}
      if(task.nextRunAt>at.toISOString())continue;
      task.nextRunAt=nextRunAt(task.schedule,at);this.store.saveTask(task);
      const shop=this.store.getShop(task.shopId);if(!shop?.enabled||shop.sessionStatus!=='valid')continue;
      try{this.worker.enqueue(task.shopId,task.id,undefined,true);}catch{/* Invalid account/task is already represented in its state. */}
    }
  }
}
