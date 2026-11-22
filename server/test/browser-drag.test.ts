import {it,expect} from 'vitest';
import {BrowserLoginService} from '../src/integrations/browser-login.js';
import {chromium,type Browser,type BrowserContext,type Page} from 'playwright';
import {afterEach,beforeEach,vi} from 'vitest';

const moves: {x:number;y:number}[]=[];
const events: string[]=[];
let service: BrowserLoginService;

function boundary(){
  moves.length=0;events.length=0;
  const page={
    goto:vi.fn(async()=>undefined),
    screenshot:vi.fn(async()=>Buffer.from([137,80,78,71,13,10,26,10])),
    mouse:{
      move:vi.fn(async(x:number,y:number)=>{moves.push({x,y});}),
      down:vi.fn(async()=>{events.push('down');}),
      up:vi.fn(async()=>{events.push('up');}),
      click:vi.fn(async()=>{events.push('click');}),
    },
    keyboard:{type:vi.fn(async()=>undefined),insertText:vi.fn(async()=>undefined),press:vi.fn(async()=>undefined)},
    on:vi.fn(),isClosed:()=>false,
  } as unknown as Page;
  const context={
    newPage:vi.fn(async()=>page),
    cookies:vi.fn(async()=>[]),
    close:vi.fn(async()=>undefined),
    setDefaultTimeout:vi.fn(),on:vi.fn(),
  } as unknown as BrowserContext;
  vi.spyOn(chromium,'launch').mockResolvedValue({
    isConnected:()=>true,close:vi.fn(async()=>undefined),on:vi.fn(),
    newContext:vi.fn(async()=>context),
  } as unknown as Browser);
}
beforeEach(()=>{service=new BrowserLoginService({dataDir:'unused'});});
afterEach(async()=>{await service.closeAll();vi.restoreAllMocks();});

it('drag performs press-move-release with many intermediate points instead of a straight jump',async()=>{
  boundary();
  const {id}=await service.create('taobao');
  await service.action(id,{type:'drag',x:100,y:400,x2:400,y2:400});
  expect(events).toEqual(['down','up']);
  expect(moves.length).toBeGreaterThan(10);
  expect(moves[0]).toEqual({x:100,y:400});
  expect(moves[moves.length-1]).toEqual({x:400,y:400});
  // x 必须单调递增，且中间点应覆盖区间
  const xs=moves.map(point=>point.x);
  for(let i=1;i<xs.length;i++)expect(xs[i]).toBeGreaterThanOrEqual(xs[i-1]);
  expect(xs.some(x=>x>150&&x<350)).toBe(true);
});

it('rejects drag coordinates outside the viewport and unknown extra fields',async()=>{
  boundary();
  const {id}=await service.create('taobao');
  await expect(service.action(id,{type:'drag',x:-5,y:10,x2:100,y2:10})).rejects.toThrow(/拖动坐标/);
  await expect(service.action(id,{type:'drag',x:100,y:400})).rejects.toThrow(/格式无效/);
  await expect(service.action(id,{type:'drag',x:100,y:400,x2:100,y2:400,script:'x'} as never)).rejects.toThrow(/格式无效/);
  expect(events).toHaveLength(0);
});
