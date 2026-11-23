import {afterEach,expect,it} from 'vitest';
import {createServer as httpServer} from 'node:http';
import {createServer,connect,type Server,type Socket} from 'node:net';
import type {Dispatcher} from 'undici';
import type {AccountCredentials} from '../../shared/contracts.js';
import {Client} from '../src/collector/client.js';
import {createCollector} from '../src/collector/index.js';
import {defaultHttpTransport,type HttpTransport} from '../src/collector/http.js';

const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
async function listen(server:Server){
 const sockets=new Set<Socket>();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 cleanup.push(async()=>{for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));});
 return (server.address() as {port:number}).port;
}
const account={platform:'taobao',cookies:'unb=proxy-fixture',userAgent:'Fixture',appKey:'fixture-key'} as AccountCredentials;
const noLimit={run:<T>(f:()=>Promise<T>)=>f()};
async function tunnel(kind:'http'|'socks',expectedAuth?:{user:string;password:string}){
 const requests:{target:string;auth?:string;user?:string;password?:string}[]=[];
 if(kind==='http'){
  const server=httpServer();server.on('connect',(req,socket,head)=>{
   requests.push({target:req.url!,auth:req.headers['proxy-authorization']});
   if(expectedAuth&&req.headers['proxy-authorization']!=='Basic '+Buffer.from(expectedAuth.user+':'+expectedAuth.password).toString('base64')){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');return;}
   const target=new URL('http://'+req.url);const upstream=connect(Number(target.port),target.hostname,()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});
   upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
  });
  const port=await listen(server);return {port,requests};
 }
 const server=createServer(socket=>{
  let buffer=Buffer.alloc(0),stage=0;let auth:{user?:string;password?:string}={};
  const consume=(chunk:Buffer)=>{
   buffer=Buffer.concat([buffer,chunk]);
   while(true){
    if(stage===0){if(buffer.length<2||buffer.length<2+buffer[1])return;buffer=buffer.subarray(2+buffer[1]);socket.write(Buffer.from([5,expectedAuth?2:0]));stage=expectedAuth?1:2;}
    else if(stage===1){if(buffer.length<2)return;const n=buffer[1];if(buffer.length<3+n)return;const m=buffer[2+n];if(buffer.length<3+n+m)return;
     auth={user:buffer.subarray(2,2+n).toString(),password:buffer.subarray(3+n,3+n+m).toString()};buffer=buffer.subarray(3+n+m);
     const ok=auth.user===expectedAuth!.user&&auth.password===expectedAuth!.password;socket.write(Buffer.from([1,ok?0:1]));if(!ok){requests.push({target:'auth-rejected',...auth});socket.end();return;}stage=2;
    }else{
     if(buffer.length<5)return;let host:string,offset:number;
     if(buffer[3]===3){const n=buffer[4];if(buffer.length<7+n)return;host=buffer.subarray(5,5+n).toString();offset=5+n;}
     else if(buffer[3]===1){if(buffer.length<10)return;host=[...buffer.subarray(4,8)].join('.');offset=8;}
     else {socket.destroy();return;}
     const port=buffer.readUInt16BE(offset);const rest=buffer.subarray(offset+2);requests.push({target:host+':'+port,...auth});socket.removeListener('data',consume);
     const upstream=connect(port,host,()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(rest.length)upstream.write(rest);socket.pipe(upstream).pipe(socket);});
     upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());return;
    }
   }
  };socket.on('data',consume);
 });
 const port=await listen(server);return {port,requests};
}
function credentials(proxy:string){return {...account,proxy} as AccountCredentials;}
async function send(proxy:string,body='origin-ok'){
 let arrivals=0;let originHeaders:Record<string,unknown>={};
 const origin=httpServer((req,res)=>{arrivals++;originHeaders=req.headers;res.end(body);});const port=await listen(origin);
 let dispatcher:Dispatcher|undefined;
 const transport:HttpTransport=async(url,init)=>{dispatcher=init.dispatcher;return {...await defaultHttpTransport(`http://127.0.0.1:${port}/`,init),url};};
 const client=new Client(credentials(proxy),{transport,limiter:noLimit});
 try {const result=await client.http.send('https://qn.taobao.com/',{method:'GET'},AbortSignal.timeout(2000));return {result,arrivals,originHeaders,dispatcher};}
 finally{if('close' in client)await (client as Client&{close:()=>Promise<void>}).close();}
}
it.each(['http','socks'] as const)('actually tunnels through %s and decodes special-character authentication',async kind=>{
 const auth={user:'fixture@user:%',password:'p@ss:/?#%中文'};const t=await tunnel(kind,auth);
 const proxy=`${kind==='socks'?'socks5':kind}://${encodeURIComponent(auth.user)}:${encodeURIComponent(auth.password)}@127.0.0.1:${t.port}`;
 const result=await send(proxy);
 expect(result.result.body).toBe('origin-ok');expect(t.requests).toHaveLength(1);expect(result.arrivals).toBe(1);
 expect(result.originHeaders['proxy-authorization']).toBeUndefined();expect(result.originHeaders.authorization).toBeUndefined();
 if(kind==='socks')expect(t.requests[0]).toMatchObject(auth);
 expect((result.dispatcher as Dispatcher & {destroyed:boolean})?.destroyed).toBe(true);
});
it('sends HTTP Basic proxy authentication when the secret is empty',async()=>{
 const t=await tunnel('http',{user:'fixture-only-user',password:''});
 const result=await send(`http://fixture-only-user@127.0.0.1:${t.port}`);
 expect(result.result.body).toBe('origin-ok');expect(t.requests).toHaveLength(1);
 expect(result.originHeaders['proxy-authorization']).toBeUndefined();
});
it('never falls back to a direct request when the configured proxy is unavailable',async()=>{
 const unused=createServer();const port=await listen(unused);await new Promise<void>(r=>unused.close(()=>r()));
 let originHits=0;const origin=httpServer((_req,res)=>{originHits++;res.end('unexpected');});const op=await listen(origin);
 const client=new Client(credentials(`http://127.0.0.1:${port}`),{limiter:noLimit,transport:async(u,i)=>({...await defaultHttpTransport(`http://127.0.0.1:${op}/`,i),url:u})});
 try {await expect(client.http.send('https://qn.taobao.com/',{method:'GET'},AbortSignal.timeout(3000))).rejects.toMatchObject({code:'NETWORK_ERROR'});expect(originHits).toBe(0);}
 finally{if('close' in client)await (client as Client&{close:()=>Promise<void>}).close();}
});
it('bounds a real SOCKS connection stalled during destination TLS negotiation',async()=>{
 let peer:Socket|undefined;
 const origin=createServer(socket=>{peer=socket;socket.on('data',()=>{});});const originPort=await listen(origin);
 const proxy=await tunnel('socks');
 const controller=new AbortController();const guard=setTimeout(()=>controller.abort(),1500);
 const collector=createCollector({timeoutMs:80,limiter:noLimit,transport:async(_url,init)=>defaultHttpTransport(`https://localhost:${originPort}/`,init)});
 const started=Date.now();
 try {await expect(collector.verify(credentials(`socks5://127.0.0.1:${proxy.port}`),controller.signal)).rejects.toMatchObject({code:'TIMEOUT'});expect(Date.now()-started).toBeLessThan(1000);}
 finally{clearTimeout(guard);controller.abort();}
 await new Promise<void>(r=>setTimeout(r,50));expect(peer?.destroyed).toBe(true);
});
it('releases a real SOCKS socket when cancelled during proxy negotiation',async()=>{
 let peer:Socket|undefined;let accepted!:()=>void;const connected=new Promise<void>(r=>accepted=r);
 const stalled=createServer(socket=>{peer=socket;socket.on('data',()=>{});accepted();});const port=await listen(stalled);
 const controller=new AbortController();const captured:Dispatcher[]=[];
 const collector=createCollector({limiter:noLimit,transport:async(_url,init)=>{if(init.dispatcher)captured.push(init.dispatcher);return defaultHttpTransport('http://127.0.0.1:1/',init);}});
 const pending=collector.verify(credentials(`socks5://127.0.0.1:${port}`),controller.signal);
 const rejection=expect(pending).rejects.toMatchObject({code:'ABORTED'});
 await connected;const cancelledAt=Date.now();controller.abort();await rejection;
 expect(Date.now()-cancelledAt).toBeLessThan(1000);
 await new Promise<void>(r=>setTimeout(r,50));
 expect(peer?.destroyed).toBe(true);expect(captured.length).toBe(1);expect((captured[0] as Dispatcher&{destroyed:boolean}).destroyed).toBe(true);
});
it.each(['failure','alternative','abort','empty-collection','verify-success'] as const)('disposes account dispatchers after %s',async mode=>{
 const captured:Dispatcher[]=[];
 const collector=createCollector({limiter:noLimit,transport:async(_url,init)=>{
  if(init.dispatcher)captured.push(init.dispatcher);
  if(mode==='abort')await new Promise<void>((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});
  if(mode==='verify-success'){
   if(!init.body)return {status:200,headers:{},body:`<script>window.__ICE_APP_CONTEXT__=${JSON.stringify({loaderData:{home:{data:{res:{item:{itemId:'100001'},skuCore:{},seller:{userId:'777777',shopName:'代理测试店'}}}}}})};</script>`};
   return {status:200,headers:{},body:JSON.stringify({ret:['SUCCESS::ok'],data:{result:JSON.stringify({success:true,data:{pagination:{current:1,pageSize:20,total:1},table:{dataSource:[{itemId:'100001',itemDesc:{desc:[{uiType:'link',text:'测试商品',url:'https://item.taobao.com/item.htm?id=100001'}]},skuList:[]}]}}})}})};
  }
  if(mode==='failure')return {status:200,headers:{},body:'not-json'};
  const challenge=mode==='alternative';
  return {status:200,headers:{},body:JSON.stringify(challenge?{ret:['FAIL_SYS_USER_VALIDATE::challenge']}:{ret:['SUCCESS::ok'],data:{result:JSON.stringify({success:true,data:{pagination:{current:1,pageSize:20,total:0},table:{dataSource:[]}}})}})};
 }});
 const creds=credentials('http://127.0.0.1:10001');
 if(mode==='empty-collection')await expect(collector.collect({credentials:{...creds,cookies:[{name:'unb',value:'proxy-fixture'}],sellerId:'fixture',shopName:'fixture',userAgent:'Fixture',appKey:'fixture-key'},shopId:'fixture',signal:new AbortController().signal,onProduct:()=>{},onProgress:()=>{}})).resolves.toMatchObject({expected:0,coverageComplete:true});
 else if(mode==='verify-success')await expect(collector.verify(creds)).resolves.toMatchObject({sellerId:'777777',proxy:'http://127.0.0.1:10001/'});
 else if(mode==='abort'){
  const controller=new AbortController();const pending=collector.verify(creds,controller.signal);setImmediate(()=>controller.abort());
  await expect(pending).rejects.toMatchObject({code:'ABORTED'});
 }
 else await expect(collector.verify(creds,AbortSignal.timeout(3000))).rejects.toMatchObject({code:mode==='alternative'?'VERIFICATION_REQUIRED':'INVALID_RESPONSE'});
 expect(captured.length).toBeGreaterThanOrEqual(mode==='alternative'?2:1);
 expect(captured.every(d=>(d as Dispatcher & {destroyed:boolean}).destroyed)).toBe(true);
});
