import type {Alert,NotificationSettings} from '../../shared/contracts.js';
import type {Store,RunRecord} from './database.js';
import {Vault} from './security.js';
import {sendServerChan} from './integrations/serverchan.js';
import {HttpError,requireValue,type ApiContext} from './api-context.js';
import {z} from 'zod';
export function notificationSettings(store:Store):NotificationSettings{return {enabled:store.getConfig('notification.enabled',false),hasSendKey:!!store.getConfig('notification.key',''),lastError:store.getConfig<string|null>('notification.error',null)};}
function getKey(store:Store,vault:Vault):string{const sealed=store.getConfig<string>('notification.key','');if(!sealed)throw new HttpError(400,'请先配置Server酱SendKey');try{return vault.open<string>(sealed);}catch{throw new HttpError(400,'通知密钥无法读取，请重新配置');}}
function report(run:RunRecord,alerts:Alert[]){
  const safe=(value:string)=>value.replace(/[|\r\n]/g,' ');
  const rows=alerts.slice(0,60).map(a=>`| ${a.productId} | ${safe(a.title).slice(0,60)} | ${safe(a.specs).slice(0,70)} | ${a.backendPrice||'缺失'} | ${a.after||'缺失'} | ${a.discount||'未知'} |`).join('\n');
  return {title:`${run.shopName}：${run.matched}个SKU触发价格预警`,short:`${run.taskName}，检查${run.checked}，排除${run.excluded}，无法判断${run.unknown}`,
    description:`### ${safe(run.taskName)}\n\n店铺：${safe(run.shopName)}\n\n状态：${run.status}；完成商品：${run.processed}/${run.expected}；失败：${run.failed}；排除SKU：${run.excluded}；无法判断SKU：${run.unknown}。\n\n| 商品ID | 标题 | 规格 | 后台标价 | 页面优惠后 | 折扣 |\n|---|---|---|---|---|---|\n${rows}\n\n${alerts.length>60?'仅展示前60条，完整结果请在监控后台查看。':''}\n作业：${run.id}\n完成时间：${run.finishedAt}`};
}
export async function notifyRun(store:Store,vault:Vault,input:RunRecord,force=false):Promise<void>{
  let run=requireValue(store.getRun(input.id));if(!run.finishedAt)throw new HttpError(400,'采集尚未结束');
  const config=notificationSettings(store);if(!config.enabled){run.notificationStatus='disabled';store.saveRun(run);if(force)throw new HttpError(400,'通知尚未启用');return;}
  if(!config.hasSendKey){run.notificationStatus='not_configured';store.saveRun(run);if(force)throw new HttpError(400,'请先配置Server酱SendKey');return;}
  if(['accepted','sending'].includes(run.notificationStatus)){if(force)throw new HttpError(409,'该作业已提交通知，请勿重复发送');return;}
  const alerts=store.listAlerts({runId:run.id});if(!alerts.length){run.notificationStatus='skipped';store.saveRun(run);return;}
  run.notificationStatus='sending';store.saveRun(run);
  try{const result=await sendServerChan(getKey(store,vault),report(run,alerts));if(!result.accepted)throw Error('通知未被接受');run=store.getRun(run.id)!;run.notificationStatus='accepted';store.setConfig('notification.error',null);store.saveRun(run);}
  catch{run=store.getRun(run.id)!;run.notificationStatus='failed';store.saveRun(run);store.setConfig('notification.error','Server酱投递失败，请检查SendKey、网络或额度');if(force)throw new HttpError(502,'Server酱投递失败，请检查SendKey、网络或额度');}
}
export function registerSettings(ctx:ApiContext):void{
  const {app,store,vault}=ctx;const settings=()=>({notification:notificationSettings(store),retentionDays:store.getConfig('retentionDays',180),timezone:'Asia/Shanghai'});
  app.get('/api/settings',async()=>settings());
  app.put('/api/settings',async request=>{const input=z.object({sendKey:z.string().trim().max(1000).optional(),notificationEnabled:z.boolean().optional(),retentionDays:z.number().int().min(7).max(3650).optional()}).parse(request.body);if(input.sendKey!==undefined)store.setConfig('notification.key',input.sendKey?vault.seal(input.sendKey):'');if(input.notificationEnabled!==undefined)store.setConfig('notification.enabled',input.notificationEnabled);if(input.retentionDays!==undefined)store.setConfig('retentionDays',input.retentionDays);store.setConfig('notification.error',null);return settings();});
  app.post('/api/notifications/test',async()=>{const key=getKey(store,vault);try{const result=await sendServerChan(key,{title:'电商价格监控通知测试',description:'Server酱通知连接测试。此消息由管理界面手动触发。'});if(!result.accepted)throw Error();return {accepted:true};}catch{throw new HttpError(502,'Server酱测试发送失败，请检查SendKey、网络或额度');}});
  app.post<{Params:{id:string}}>('/api/runs/:id/notify',async request=>{const run=requireValue(store.getRun(request.params.id));await ctx.notify(run,true);return {accepted:store.getRun(run.id)?.notificationStatus==='accepted'};});
}
