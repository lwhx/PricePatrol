import {expect,it} from 'vitest';
import {normalizeAccountProxy} from '../../shared/account-proxy.js';
it.each([
 'socks5://user@proxy.example',
 'socks5://:password@proxy.example',
 `socks5://${encodeURIComponent('中'.repeat(86))}:password@proxy.example`,
 `socks5://user:${encodeURIComponent('中'.repeat(86))}@proxy.example`,
])('rejects credentials that cannot be encoded in a SOCKS5 authentication frame (%#)',proxy=>{
 expect(()=>normalizeAccountProxy(proxy)).toThrow(expect.objectContaining({code:'INVALID_CONFIGURATION'}));
});
it('accepts the maximum RFC1929 credential byte length',()=>{
 const proxy=`socks5://${'u'.repeat(255)}:${'p'.repeat(255)}@proxy.example`;
 expect(normalizeAccountProxy(proxy)).toContain('@proxy.example:1080/');
});
