import {it,expect} from 'vitest';
import {Vault,hashPassword,verifyPassword} from '../src/security.js';
it('encrypts with random IV and rejects tampering or wrong key',()=>{const v=new Vault('x'.repeat(64));const a=v.seal({cookie:'secret'}),b=v.seal({cookie:'secret'});expect(a).not.toBe(b);expect(a).not.toContain('secret');expect(v.open(a)).toEqual({cookie:'secret'});expect(()=>new Vault('y'.repeat(64)).open(a)).toThrow();});
it('uses password hash with salt',async()=>{const a=await hashPassword('0123456789');expect(a).not.toContain('0123456789');expect(await verifyPassword('0123456789',a)).toBe(true);expect(await verifyPassword('wrong',a)).toBe(false);});
