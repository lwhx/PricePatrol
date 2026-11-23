import {randomBytes,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Store} from './database.js';
import {verifyPassword,tokenHash} from './security.js';
import {ADMIN_PASSWORD_MIN_LENGTH,ADMIN_PASSWORD_MAX_LENGTH,SETUP_TOKEN_MAX_LENGTH,hasAdminPassword,initializeAdminPassword} from './bootstrap.js';
import {HttpError} from './api-context.js';
const COOKIE='price_monitor_session';
const DAY=86400000;
export async function registerAuth(app:FastifyInstance,store:Store,allowedOrigins:string[],setupToken?:string):Promise<void>{
  store.db.exec('CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  const configured=()=>hasAdminPassword(store);
  const setupTokenDigest=setupToken ? Buffer.from(tokenHash(setupToken),'hex') : undefined;
  const requireSetupToken=process.env.NODE_ENV==='production' || !!setupTokenDigest;
  const authenticated=(token?:string)=>!!token&&!!store.db.prepare('SELECT hash FROM auth_sessions WHERE hash=? AND expires>?').get(tokenHash(token),Date.now());
  app.addHook('onRequest',async(request)=>{
    if(!request.url.startsWith('/api/'))return;
    if(!['GET','HEAD','OPTIONS'].includes(request.method)&&request.headers.origin){let good=false;try{const origin=new URL(request.headers.origin);good=origin.host===request.headers.host||allowedOrigins.includes(origin.origin);}catch{}if(!good)throw new HttpError(403,'不允许来自其他网站的操作');}
    const path=request.url.split('?')[0];if(['/api/health','/api/auth/status','/api/auth/setup','/api/auth/login'].includes(path!))return;
    if(!authenticated(request.cookies[COOKIE]))throw new HttpError(401,'请先登录');
  });
  app.get('/api/auth/status',async request=>{
    const hasPassword=configured();
    return {configured:hasPassword,authenticated:authenticated(request.cookies[COOKIE]),setupTokenRequired:!hasPassword && requireSetupToken};
  });
  app.post('/api/auth/setup',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(request,reply)=>{
    if(configured())throw new HttpError(409,'管理员已经设置');
    const {password,setupToken:submittedToken}=z.object({
      password:z.string().min(ADMIN_PASSWORD_MIN_LENGTH).max(ADMIN_PASSWORD_MAX_LENGTH),
      setupToken:z.string().trim().max(SETUP_TOKEN_MAX_LENGTH).optional(),
    }).parse(request.body);
    if(requireSetupToken && (!setupTokenDigest || !submittedToken || !timingSafeEqual(setupTokenDigest,Buffer.from(tokenHash(submittedToken),'hex')))){
      throw new HttpError(403,'需要有效的初始化令牌');
    }
    if(!await initializeAdminPassword(store,password))throw new HttpError(409,'管理员已经设置');
    const token=randomBytes(32).toString('base64url');store.db.prepare('INSERT INTO auth_sessions(hash,expires) VALUES(?,?)').run(tokenHash(token),Date.now()+7*DAY);reply.setCookie(COOKIE,token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:7*86400});return {ok:true};
  });
  app.post('/api/auth/login',{config:{rateLimit:{max:8,timeWindow:'1 minute'}}},async(request,reply)=>{
    const {password}=z.object({password:z.string().min(1).max(ADMIN_PASSWORD_MAX_LENGTH)}).parse(request.body);if(!configured()||!await verifyPassword(password,store.getConfig('admin.hash','')))throw new HttpError(401,'密码错误');
    const token=randomBytes(32).toString('base64url');store.db.prepare('DELETE FROM auth_sessions WHERE expires<?').run(Date.now());store.db.prepare('INSERT INTO auth_sessions(hash,expires) VALUES(?,?)').run(tokenHash(token),Date.now()+7*DAY);reply.setCookie(COOKIE,token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:7*86400});return {ok:true};
  });
  app.post('/api/auth/logout',async(request,reply)=>{const token=request.cookies[COOKIE];if(token)store.db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(tokenHash(token));reply.clearCookie(COOKIE,{path:'/'});return {ok:true};});
}
