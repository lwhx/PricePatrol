import {afterEach, expect, it, vi} from 'vitest';
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils';
import {computed, defineComponent, h, inject, provide, type ComputedRef} from 'vue';
import ShopsPage from '../src/pages/ShopsPage.vue';
const {confirm,success}=vi.hoisted(()=>({confirm:vi.fn(),success:vi.fn()}));
vi.mock('element-plus',()=>({ElMessageBox:{confirm},ElMessage:{success,error:vi.fn()}}));
const Box=defineComponent({setup(_, {slots}){return ()=>h('div',slots.default?.());}});
const Table=defineComponent({props:['data'],setup(props,{slots}){provide('rows',computed(()=>props.data));return ()=>h('div',{'data-table':true},slots.default?.());}});
const Column=defineComponent({setup(_,{slots}){const rows=inject<ComputedRef<Record<string,unknown>[]>>('rows')!;return ()=>h('div',rows.value.map(row=>h('div',{'data-shop':row.id},slots.default?.({row}))));}});
const Button=defineComponent({props:['disabled'],emits:['click'],setup(props,{slots,emit}){return ()=>h('button',{disabled:props.disabled,onClick:()=>emit('click')},slots.default?.());}});
let wrapper:VueWrapper|undefined;
afterEach(()=>{wrapper?.unmount();wrapper=undefined;vi.unstubAllGlobals();vi.clearAllMocks();});
async function open(){
 let shops=[{id:'fixture-shop',name:'移除测试店',sellerId:'fixture-seller',platform:'tmall',enabled:true,sessionStatus:'valid',hasCookies:true,lastVerifiedAt:null,lastError:null}];
 const requests:{url:string;method:string}[]=[];
 vi.stubGlobal('fetch',async(url:string,options:{method?:string}={})=>{const method=options.method||'GET';requests.push({url,method});if(method==='DELETE')shops=[];return {ok:true,status:200,text:async()=>JSON.stringify(method==='DELETE'?{ok:true}:{shops})};});
 wrapper=mount(ShopsPage,{global:{stubs:{PageHeader:Box,ErrorBanner:true,StatusTag:true,RemoteLogin:true,ElButton:Button,ElTable:Table,ElTableColumn:Column,ElTag:Box,ElDropdown:Box,ElDropdownItem:true,ElDropdownMenu:true,ElDialog:true,ElInput:true,ElForm:true,ElFormItem:true,ElRadioGroup:true,ElRadioButton:true},directives:{loading:()=>{}}}});
 await flushPromises();return requests;
}
function removal(){return wrapper!.findAll('button').find(button=>/移除/.test(button.text()))!;}
it('confirms credential removal and stopped plans, then removes the account row after success',async()=>{
 confirm.mockResolvedValue('confirm');const requests=await open();
 expect(wrapper!.find('[data-shop="fixture-shop"]').exists()).toBe(true);
 await removal().trigger('click');await flushPromises();
 const message=String(confirm.mock.calls[0][0]);
 expect(message).toContain('清除');expect(message).toContain('凭据');expect(message).toContain('停止');expect(message).toContain('采集');expect(message).toContain('预警');expect(message).toContain('历史');expect(message).toContain('重新导入');
 expect(requests.some(r=>r.method==='DELETE'&&r.url==='/api/shops/fixture-shop')).toBe(true);
 expect(wrapper!.find('[data-shop="fixture-shop"]').exists()).toBe(false);
 expect(success).toHaveBeenCalledWith(expect.stringContaining('移除'));
});
it('keeps the account when removal confirmation is cancelled',async()=>{
 confirm.mockRejectedValue('cancel');const requests=await open();
 await removal().trigger('click');await flushPromises();
 expect(requests).toEqual([{url:'/api/shops',method:'GET'}]);
 expect(wrapper!.find('[data-shop="fixture-shop"]').exists()).toBe(true);
});
