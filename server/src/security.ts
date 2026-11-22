import {randomBytes,createCipheriv,createDecipheriv,scrypt as scryptCb,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCb);
export class Vault {
  private key:Buffer;
  constructor(secret:string){if(secret.length<32)throw Error('加密密钥至少32个字符');this.key=createHash('sha256').update(secret).digest();}
  seal(value:unknown):string{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv),encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),encrypted].map(x=>x.toString('base64url')).join('.');}
  open<T=unknown>(value:string):T{const parts=value.split('.');if(parts.length!==3)throw Error('凭据密文损坏');const [iv,tag,body]=parts.map(x=>Buffer.from(x,'base64url'));const decipher=createDecipheriv('aes-256-gcm',this.key,iv!);decipher.setAuthTag(tag!);return JSON.parse(Buffer.concat([decipher.update(body!),decipher.final()]).toString('utf8')) as T;}
}
export async function hashPassword(password:string):Promise<string>{const salt=randomBytes(16).toString('hex'),derived=await scrypt(password,salt,64) as Buffer;return `${salt}:${derived.toString('hex')}`;}
export async function verifyPassword(password:string,hash:string):Promise<boolean>{try{const [salt,key]=hash.split(':');const actual=await scrypt(password,salt!,64) as Buffer;const expected=Buffer.from(key!,'hex');return expected.length===actual.length&&timingSafeEqual(expected,actual);}catch{return false;}}
export function tokenHash(token:string):string{return createHash('sha256').update(token).digest('hex');}
