import {randomUUID} from 'node:crypto';
import type {RouteShorthandOptions} from 'fastify';
import {z} from 'zod';
import type {AccountCredentials,VerifiedAccount,Shop} from '../../shared/contracts.js';
import {accountSchema,cookieSchema,appKeySchema} from './validation.js';
import {HttpError,publicRun,requireValue,type ApiContext} from './api-context.js';
import {CollectorError} from './collector/errors.js';
import {submitCollection} from './collection-submissions.js';

const verificationMessages:Partial<Record<string,string>>={
  APPKEY_REQUIRED:'缺少 appKey：请在导入包里带上 appKey，或在下方「App key」填写千牛后台实际使用的 appKey 后重试',
  COOKIE_INVALID:'Cookie 无效或已过期：请重新登录淘宝/天猫后再次导出 Cookie',
  AUTH_REQUIRED:'Cookie 已失效或缺少商品读取权限：请核对权限并重新登录淘宝/天猫',
  IDENTITY_UNVERIFIED:'无法核验店铺身份：请确认店铺存在在售商品、账号有商品读取权限且 Cookie 完整',
  IDENTITY_CHANGED:'登录账号与绑定店铺不一致：请确认用的是该店铺的子账号',
  PLATFORM_MISMATCH:'平台不匹配：请确认选择的平台与该店铺一致',
  RATE_LIMIT:'请求被限流：请稍后再试',
  ABORTED:'核验已停止：请稍后重试',
  TIMEOUT:'核验超时：请稍后重试',
  NETWORK_ERROR:'店铺核验连接失败：请检查服务器网络或稍后重试',
  HTTP_ERROR:'平台接口暂时无法完成核验：请稍后重试',
};
const invalidSessionCodes=new Set(['AUTH_REQUIRED','COOKIE_INVALID','IDENTITY_CHANGED']);
class VerificationError extends HttpError{
  constructor(readonly code:string,message:string,statusCode=400){super(statusCode,message);}
}
const verificationRoute:RouteShorthandOptions={
  errorHandler(error,_request,reply){
    if(error instanceof VerificationError)return reply.code(error.statusCode).send({error:error.message,code:error.code});
    throw error;
  },
};

export function registerAccounts(ctx:ApiContext):void{
  const {app,store,collector,browser}=ctx;
  async function verify(input:AccountCredentials):Promise<VerifiedAccount>{
    try{return await collector.verify(input,AbortSignal.timeout(60000));}
    catch(error){
      const code=error instanceof Error&&'code' in error?error.code:undefined;
      const message=typeof code==='string'&&Object.hasOwn(verificationMessages,code)?verificationMessages[code]:undefined;
      if(typeof code!=='string'||(!message&&!(error instanceof CollectorError)))throw error;
      throw new VerificationError(code,message??'店铺验证失败，请确认 Cookie 完整、平台正确且有商品读取权限');
    }
  }
  function credentialVersions(platform:AccountCredentials['platform']){
    return store.transaction(()=>new Map(store.listShops().filter(shop=>shop.platform===platform).map(shop=>[shop.id,store.getCredentialVersion(shop.id)])));
  }
  function credentialsFor(id:string){
    return store.transaction(()=>{
      requireValue(store.getShop(id),'店铺不存在');
      return {credentials:store.getCredentials(id),version:store.getCredentialVersion(id)};
    });
  }
  function saveAccount(account:VerifiedAccount,versions:ReadonlyMap<string,number>,options:{id?:string;name?:string;enabled?:boolean}={}):Shop{
    return store.transaction(()=>{
      const prior=options.id?requireValue(store.getShop(options.id),'店铺不存在'):store.listShops().find(shop=>shop.sellerId===account.sellerId&&shop.platform===account.platform);
      if(prior&&versions.get(prior.id)!==store.getCredentialVersion(prior.id))
        throw new VerificationError('CREDENTIALS_CHANGED','店铺凭据已更新，请重新核验',409);
      if(prior&&(account.sellerId!==prior.sellerId||account.platform!==prior.platform))
        throw new VerificationError('IDENTITY_CHANGED','登录账号与原店铺不一致，请添加为新账号',409);
      const at=new Date().toISOString();
      const shop:Shop={id:prior?.id||randomUUID(),name:options.name||prior?.name||account.shopName,sellerId:account.sellerId,platform:account.platform,enabled:options.enabled??prior?.enabled??true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:prior?.createdAt||at,updatedAt:at,hasCookies:true};
      store.saveShop(shop,account);
      return shop;
    });
  }
  app.get('/api/shops',async()=>({shops:store.listShops()}));
  app.post('/api/shops',verificationRoute,async request=>{
    const input=accountSchema.parse(request.body);
    const versions=credentialVersions(input.platform);
    return {shop:saveAccount(await verify(input),versions,{name:input.name})};
  });
  app.patch<{Params:{id:string}}>('/api/shops/:id',verificationRoute,async request=>{
    const {id}=request.params;
    const input=z.object({name:z.string().trim().min(1).max(100).optional(),enabled:z.boolean().optional(),cookies:cookieSchema.optional(),userAgent:z.string().max(1000).optional(),appKey:appKeySchema.optional()}).parse(request.body);
    if(input.cookies||input.userAgent||input.appKey){
      const {credentials,version}=credentialsFor(id);
      const account=await verify({...credentials,...input});
      return {shop:saveAccount(account,new Map([[id,version]]),{id,name:input.name,enabled:input.enabled})};
    }
    return store.transaction(()=>{
      const prior=requireValue(store.getShop(id),'店铺不存在');
      const shop={...prior,name:input.name||prior.name,enabled:input.enabled??prior.enabled,updatedAt:new Date().toISOString()};
      store.saveShop(shop);
      return {shop};
    });
  });
  app.delete<{Params:{id:string}}>('/api/shops/:id',async request=>{const shop=requireValue(store.getShop(request.params.id));store.saveShop({...shop,enabled:false,updatedAt:new Date().toISOString()});return {ok:true};});
  app.post<{Params:{id:string}}>('/api/shops/:id/verify',verificationRoute,async request=>{
    const {id}=request.params;
    const {credentials,version}=credentialsFor(id);
    try{return {shop:saveAccount(await verify(credentials),new Map([[id,version]]),{id})};}
    catch(error){
      if(error instanceof VerificationError&&error.code!=='CREDENTIALS_CHANGED'){
        store.transaction(()=>{
          const current=store.getShop(id);
          if(!current||store.getCredentialVersion(id)!==version)return;
          const sessionStatus=invalidSessionCodes.has(error.code)?'auth_required':current.sessionStatus;
          store.saveShop({...current,sessionStatus,lastError:error.message,updatedAt:new Date().toISOString()});
        });
      }
      throw error;
    }
  });
  app.post<{Params:{id:string}}>('/api/shops/:id/collect',async request=>{
    const input=z.object({
      productIds:z.array(z.string().regex(/^\d{6,20}$/)).min(1).max(20000).optional(),
      idempotencyKey:z.string().trim().min(1).max(128).optional(),
    }).parse(request.body||{});
    return {run:publicRun(submitCollection(store,ctx.worker,request.params.id,input.productIds,input.idempotencyKey))};
  });
  const loginPlatforms=new Map<string,'tmall'|'taobao'>();
  app.post('/api/login-sessions',async request=>{const input=z.object({platform:z.enum(['tmall','taobao'])}).parse(request.body);const result=await browser.create(input.platform);loginPlatforms.set(result.id,input.platform);return result;});
  app.get<{Params:{id:string}}>('/api/login-sessions/:id/screenshot',async(request,reply)=>{reply.header('cache-control','no-store').type('image/png');return browser.screenshot(request.params.id);});
  app.post<{Params:{id:string}}>('/api/login-sessions/:id/action',async request=>{const input=z.object({type:z.enum(['click','type','press','drag']),x:z.number().optional(),y:z.number().optional(),x2:z.number().optional(),y2:z.number().optional(),text:z.string().max(2000).optional(),key:z.string().max(40).optional()}).parse(request.body);await browser.action(request.params.id,input);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/login-sessions/:id/complete',verificationRoute,async request=>{const input=z.object({name:z.string().max(100).optional(),platform:z.enum(['tmall','taobao'])}).parse(request.body);if(loginPlatforms.get(request.params.id)!==input.platform)throw new HttpError(400,'登录窗口平台不匹配或已过期');const versions=credentialVersions(input.platform);const cookies=await browser.cookies(request.params.id);const account=await verify({platform:input.platform,cookies});const shop=saveAccount(account,versions,{name:input.name});await browser.close(request.params.id);loginPlatforms.delete(request.params.id);return {shop};});
  app.delete<{Params:{id:string}}>('/api/login-sessions/:id',async request=>{await browser.close(request.params.id);loginPlatforms.delete(request.params.id);return {ok:true};});
}
