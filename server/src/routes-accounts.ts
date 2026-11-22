import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {AccountCredentials,VerifiedAccount,Shop} from '../../shared/contracts.js';
import {accountSchema,cookieSchema,appKeySchema} from './validation.js';
import {HttpError,requireValue,type ApiContext} from './api-context.js';
export function registerAccounts(ctx:ApiContext):void{
  const {app,store,collector,browser}=ctx;
  // 把采集器的真实失败原因带出来。统一吞成一句"验证失败"会让 APPKEY_REQUIRED、Cookie 过期、
  // 平台不匹配这些可操作的问题全部无法定位，用户只能反复试。
  const verify=async(input:AccountCredentials)=>{try{return await collector.verify(input,AbortSignal.timeout(60000));}catch(error){
    const code=error instanceof Error&&'code'in error?String((error as {code?:unknown}).code):'';
    const hint=(message:string)=>new HttpError(400,message);
    if(code==='APPKEY_REQUIRED')throw hint('缺少 appKey：请在导入包里带上 appKey，或在下方「App key」填写千牛后台实际使用的 appKey 后重试');
    if(code==='COOKIE_INVALID')throw hint('Cookie 无效或已过期：请重新登录淘宝/天猫后再次导出 Cookie');
    if(code==='AUTH_REQUIRED')throw hint('Cookie 已失效：请重新登录淘宝/天猫后再次导出 Cookie');
    if(code==='IDENTITY_UNVERIFIED')throw hint('无法核验店铺身份：该账号可能没有商品读取权限，或 Cookie 不完整');
    if(code==='IDENTITY_CHANGED')throw hint('登录账号与绑定店铺不一致：请确认用的是该店铺的子账号');
    if(code==='PLATFORM_MISMATCH')throw hint('平台不匹配：请确认选择的平台与该店铺一致');
    if(code==='RATE_LIMIT')throw hint('请求被限流：请稍后再试');
    if(code==='ABORTED'||code==='TIMEOUT')throw hint('核验超时：请稍后重试');
    throw hint('店铺验证失败，请确认 Cookie 完整、平台正确且有商品读取权限；如需验证请重新登录');
  }};
  function saveAccount(account:VerifiedAccount,label?:string,existing?:Shop):Shop{
    if(existing&&(account.sellerId!==existing.sellerId||account.platform!==existing.platform))throw new HttpError(409,'登录账号与原店铺不一致，请添加为新账号');
    const prior=existing||store.listShops().find(s=>s.sellerId===account.sellerId&&s.platform===account.platform);const at=new Date().toISOString();
    const shop:Shop={id:prior?.id||randomUUID(),name:label||prior?.name||account.shopName,sellerId:account.sellerId,platform:account.platform,enabled:prior?.enabled??true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:prior?.createdAt||at,updatedAt:at,hasCookies:true};store.saveShop(shop,account);return shop;
  }
  app.get('/api/shops',async()=>({shops:store.listShops()}));
  app.post('/api/shops',async request=>{const input=accountSchema.parse(request.body);return {shop:saveAccount(await verify(input),input.name)};});
  app.patch<{Params:{id:string}}>('/api/shops/:id',async request=>{
    const prior=requireValue(store.getShop(request.params.id),'店铺不存在');const input=z.object({name:z.string().trim().min(1).max(100).optional(),enabled:z.boolean().optional(),cookies:cookieSchema.optional(),userAgent:z.string().max(1000).optional(),appKey:appKeySchema.optional()}).parse(request.body);
    let shop=prior;if(input.cookies||input.userAgent||input.appKey){const old=store.getCredentials(prior.id);shop=saveAccount(await verify({...old,...input}),input.name,prior);}
    shop={...shop,name:input.name||shop.name,enabled:input.enabled??shop.enabled,updatedAt:new Date().toISOString()};store.saveShop(shop);return {shop};
  });
  app.delete<{Params:{id:string}}>('/api/shops/:id',async request=>{const shop=requireValue(store.getShop(request.params.id));store.saveShop({...shop,enabled:false,updatedAt:new Date().toISOString()});return {ok:true};});
  app.post<{Params:{id:string}}>('/api/shops/:id/verify',async request=>{const prior=requireValue(store.getShop(request.params.id));try{return {shop:saveAccount(await verify(store.getCredentials(prior.id)),prior.name,prior)};}catch(error){store.saveShop({...prior,sessionStatus:'auth_required',lastError:'账号验证失败',updatedAt:new Date().toISOString()});throw error;}});
  app.post<{Params:{id:string}}>('/api/shops/:id/collect',async request=>{const input=z.object({productIds:z.array(z.string().regex(/^\d{6,20}$/)).min(1).max(20000).optional()}).parse(request.body||{});return {run:ctx.worker.enqueue(request.params.id,null,input.productIds)};});
  const loginPlatforms=new Map<string,'tmall'|'taobao'>();
  app.post('/api/login-sessions',async request=>{const input=z.object({platform:z.enum(['tmall','taobao'])}).parse(request.body);const result=await browser.create(input.platform);loginPlatforms.set(result.id,input.platform);return result;});
  app.get<{Params:{id:string}}>('/api/login-sessions/:id/screenshot',async(request,reply)=>{reply.header('cache-control','no-store').type('image/png');return browser.screenshot(request.params.id);});
  app.post<{Params:{id:string}}>('/api/login-sessions/:id/action',async request=>{const input=z.object({type:z.enum(['click','type','press','drag']),x:z.number().optional(),y:z.number().optional(),x2:z.number().optional(),y2:z.number().optional(),text:z.string().max(2000).optional(),key:z.string().max(40).optional()}).parse(request.body);await browser.action(request.params.id,input);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/login-sessions/:id/complete',async request=>{const input=z.object({name:z.string().max(100).optional(),platform:z.enum(['tmall','taobao'])}).parse(request.body);if(loginPlatforms.get(request.params.id)!==input.platform)throw new HttpError(400,'登录窗口平台不匹配或已过期');const cookies=await browser.cookies(request.params.id);const account=await verify({platform:input.platform,cookies});const shop=saveAccount(account,input.name);await browser.close(request.params.id);loginPlatforms.delete(request.params.id);return {shop};});
  app.delete<{Params:{id:string}}>('/api/login-sessions/:id',async request=>{await browser.close(request.params.id);loginPlatforms.delete(request.params.id);return {ok:true};});
}
