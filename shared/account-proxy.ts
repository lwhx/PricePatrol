const configurationMessage='代理配置无效：请检查代理协议、主机、端口和认证信息';
function invalidProxy():never{
  throw Object.assign(new Error(configurationMessage),{code:'INVALID_CONFIGURATION'});
}
function authentication(value:string):string{
  const decoded=decodeURIComponent(value);
  if(/[\u0000-\u001f\u007f-\u009f]/.test(decoded))invalidProxy();
  return encodeURIComponent(decoded);
}

/** Validate before URL parsing can discard controls or normalize a non-root path. */
export function normalizeAccountProxy(value:string|null|undefined):string|undefined{
  if(value==null)return undefined;
  if(typeof value!=='string')invalidProxy();
  const text=value.trim();
  if(!text)return undefined;
  if(/[\u0000-\u001f\u007f-\u009f\\]/.test(value))invalidProxy();
  const endpoint=/^(https?|socks5?):\/\/([^/?#]+)\/?$/i.exec(text);
  if(!endpoint||endpoint[2].endsWith(':'))invalidProxy();
  try{
    const url=new URL(text);
    if(!url.hostname||url.search||url.hash||(url.pathname&&url.pathname!=='/'))invalidProxy();
    // WHATWG does not validate/canonicalize hosts for non-special SOCKS schemes.
    url.hostname=new URL(`http://${url.host}`).hostname;
    if(!url.hostname)invalidProxy();
    if(url.port&&(Number(url.port)<1||Number(url.port)>65535))invalidProxy();
    if(url.protocol==='socks:'||url.protocol==='socks5:'){
      url.port||='1080';
      if(url.username||url.password){
        const bytes=new TextEncoder();
        const username=bytes.encode(decodeURIComponent(url.username)),password=bytes.encode(decodeURIComponent(url.password));
        if(!username.length||!password.length||username.length>255||password.length>255)invalidProxy();
      }
    }
    url.username=authentication(url.username);url.password=authentication(url.password);
    url.pathname='/';
    return url.href;
  }catch{invalidProxy();}
}
