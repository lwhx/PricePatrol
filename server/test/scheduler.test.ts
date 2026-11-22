import {it,expect} from 'vitest';
import {nextRunAt} from '../src/scheduler.js';
it('schedules day/week in declared timezone and leaves manual unscheduled',()=>{const at=new Date('2026-11-22T00:00:00Z');expect(nextRunAt({kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'},at)).toBe('2026-11-22T01:00:00.000Z');expect(nextRunAt({kind:'weekly',time:'09:00',days:[1],timezone:'Asia/Shanghai'},at)).toBe('2026-11-23T01:00:00.000Z');expect(nextRunAt({kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'},at)).toBeNull();});
it('rejects bad schedules rather than executing every minute',()=>{expect(()=>nextRunAt({kind:'daily',time:'99:00',days:[],timezone:'Asia/Shanghai'})).toThrow();expect(()=>nextRunAt({kind:'weekly',time:'09:00',days:[],timezone:'Asia/Shanghai'})).toThrow();});
