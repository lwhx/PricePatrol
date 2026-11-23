import type {ExportResult} from './contracts.js';

export type ExportJobStatus='queued'|'running'|'ready'|'failed'|'cancelled';
export interface ExportJob {
 id:string;
 status:ExportJobStatus;
 createdAt:string;
 expiresAt:string;
 filename:string;
 mime:string;
 preview:string;
 rowCount:number;
 sourceCount:number;
 bytes:number;
 error:string|null;
}
export type ExportSubmission=ExportResult|{job:ExportJob};
