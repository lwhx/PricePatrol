import {openSync, closeSync, writeSync, readFileSync, fsyncSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {renderExport,INLINE_EXPORT_LIMITS,type ExportMetrics} from './export.js';
import {registerQueryFunctions} from './query.js';
import type {ExportInput} from '../../shared/contracts.js';

export interface ExportWork {database:string;partial:string;input:ExportInput;forceFile:boolean}
export type ExportMessage={kind:'file'}|{kind:'done';metrics:ExportMetrics;content?:string}|{kind:'error';message:string;status:number};
export function executeExport(work:ExportWork,send:(message:ExportMessage)=>void):void{
 const db=new DatabaseSync(work.database,{readOnly:true});
 try{
  db.exec('PRAGMA busy_timeout=5000; PRAGMA temp_store=FILE');
  registerQueryFunctions(db);
  const fd=openSync(work.partial,'wx',0o600);
  let file=work.forceFile,seenBytes=0,buffer='';
  function fileOnly(){if(!file){file=true;send({kind:'file'});}}
  function flush(){
   const bytes=Buffer.from(buffer);buffer='';
   let offset=0;
   while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);
  }
  let metrics:ExportMetrics;
  try{
   metrics=renderExport({db},work.input,chunk=>{
    seenBytes+=Buffer.byteLength(chunk);
    if(seenBytes>INLINE_EXPORT_LIMITS.bytes)fileOnly();
    buffer+=chunk;
    if(buffer.length>=64*1024)flush();
   },count=>{if(count>INLINE_EXPORT_LIMITS.sourceRows)fileOnly();});
   flush();
   if(file)fsyncSync(fd);
  }finally{closeSync(fd);}
  send({kind:'done',metrics,...(file?{}:{content:readFileSync(work.partial,'utf8')})});
 }finally{db.close();}
}
