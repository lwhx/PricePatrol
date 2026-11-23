import {ProxyAgent,Socks5ProxyAgent,type Dispatcher,type buildConnector} from 'undici';
import {createConnection,type Socket} from 'node:net';
import {normalizeAccountProxy} from '../../../shared/account-proxy.js';
import {CollectorError} from './errors.js';

/** One dispatcher per collector operation. Only Client owns and disposes it. */
export function accountProxy(value:string|undefined):{proxy?:string;dispatcher?:Dispatcher;close?:()=>Promise<void>;interrupt?:()=>void}{
    try {
        const proxy=normalizeAccountProxy(value);
        if(!proxy)return {};
        const url=new URL(proxy);
        if(url.protocol==='socks:'||url.protocol==='socks5:'){
            const username=decodeURIComponent(url.username),password=decodeURIComponent(url.password);
            // Strip URL auth so Undici cannot fall back to percent-encoded credentials.
            url.username='';url.password='';
            const sockets=new Set<Socket>();
            let disposed=false;
            const connect:buildConnector.connector=(options,callback)=>{
                if(disposed){callback(new Error('Proxy operation closed'),null);return;}
                const socket=createConnection({host:options.hostname.replace(/^\[|\]$/g,''),port:Number(options.port)});
                sockets.add(socket);
                let delivered=false;
                socket.setTimeout(10000,()=>socket.destroy(new Error('Proxy connection timed out')));
                socket.once('connect',()=>{delivered=true;socket.setTimeout(0);callback(null,socket);});
                socket.on('error',error=>{if(!delivered){delivered=true;callback(error,null);}});
                socket.once('close',()=>sockets.delete(socket));
            };
            const dispatcher=new Socks5ProxyAgent(url,{username,password,connect});
            const interrupt=()=>{
                // Includes sockets still negotiating SOCKS/TLS, before Pool takes ownership.
                for(const socket of sockets)socket.destroy(new Error('Proxy request interrupted'));
            };
            return {proxy,dispatcher,interrupt,close:async()=>{
                disposed=true;
                interrupt();
                await dispatcher.destroy();
            }};
        }
        const auth=url.username||url.password
            ? 'Basic '+Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')
            : undefined;
        url.username='';url.password='';
        const dispatcher=new ProxyAgent({uri:url.href,...(auth?{token:auth}:{})});
        return {proxy,dispatcher,close:()=>dispatcher.destroy()};
    }catch{
        // Never attach the URL or a dependency error as a cause: it may contain credentials.
        throw new CollectorError('INVALID_CONFIGURATION','代理配置无效，请检查协议、主机、端口及认证格式');
    }
}
