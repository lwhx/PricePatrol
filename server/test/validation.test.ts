import {it,expect} from 'vitest';
import {taskSchema,alertTaskSchema,querySchema} from '../src/validation.js';
it('validates collection scope separately from required alert rules',()=>{
  const collection={shopId:'s',name:'t',enabled:true,scope:'all',productIds:[],schedule:{kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'}};
  expect(taskSchema.safeParse(collection).success).toBe(true);
  expect(taskSchema.safeParse({...collection,scope:'selected'}).success).toBe(false);
  const alert={collectionTaskId:'t',name:'a',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:false};
  expect(alertTaskSchema.safeParse(alert).success).toBe(true);
  expect(alertTaskSchema.safeParse({...alert,rules:[]}).success).toBe(false);
  expect(querySchema.safeParse({groups:[{mode:'all',conditions:[{field:'discount',op:'eq',value:'8.501'}]}]}).success).toBe(false);
});
