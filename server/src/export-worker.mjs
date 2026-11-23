import {parentPort,workerData} from 'node:worker_threads';
import {tsImport} from 'tsx/esm/api';

try {
 const {executeExport}=await tsImport('./export-executor.ts',import.meta.url);
 executeExport(workerData,message=>parentPort.postMessage(message));
} catch(error) {
 const status=error?.statusCode;
 // Only deliberate input errors are safe for the API. SQLite and filesystem errors may contain paths.
 parentPort.postMessage({kind:'error',status:status===400?400:500,message:status===400?error.message:'文件导出失败，请重试'});
}
