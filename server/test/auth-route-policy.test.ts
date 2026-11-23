import type {FastifyInstance} from 'fastify';
import {it,expect} from 'vitest';
import {Store} from '../src/database.js';
import {registerAuth} from '../src/auth.js';

it('applies the authentication and Origin policy from the router’s matched template',async()=>{
 type MatchedRequest={routeOptions:{url:string};method:string;headers:Record<string,string>;cookies:Record<string,string>};
 let enforce!:(request:MatchedRequest)=>Promise<void>;
 const app={addHook:(_name:string,fn:typeof enforce)=>{enforce=fn;},get(){},post(){}};
 const store=new Store(':memory:','fixture-auth-route-key'.repeat(2));
 try{
  await registerAuth(app as unknown as FastifyInstance,store,[]);
  const request:MatchedRequest={routeOptions:{url:'/api/export-jobs/:id/download'},method:'GET',headers:{},cookies:{}};
  await expect(enforce(request)).rejects.toMatchObject({statusCode:401});
  await expect(enforce({...request,method:'DELETE',headers:{host:'fixture.test',origin:'https://unrelated.example'}})).rejects.toMatchObject({statusCode:403});
  await expect(enforce({...request,routeOptions:{url:'/api/auth/status'}})).resolves.toBeUndefined();
 }finally{store.close();}
});
