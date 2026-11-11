import { Worker } from 'node:worker_threads';
import { captureKey } from './capture.mjs';
import { discoverAccounts } from './discovery.mjs';
const active=new Set();process.once('exit',()=>{for(const worker of active)worker.terminate();});
export async function detectDirectories(options = {}) { return (await discoverAccounts(options)).candidates; }
export async function runWorker(request,{signal,onEvent=()=>{}}={}) {
  if(signal?.aborted)return {state:'canceled'};
  if(request.action==='detect'){
    try {
      const result = await discoverAccounts({ signal, onProgress: p => onEvent({type:'progress',message:`正在搜索微信数据目录，已检查 ${p.scanned} 个目录，找到 ${p.found} 个账号…`}) });
      onEvent({type:'detected',...result});return {state:'completed'};
    } catch(error) { if(signal?.aborted)return {state:'canceled'};throw error; }
  }
  if(request.action==='capture')return captureKey(request,{signal,onEvent});
  if(request.action!=='decrypt')throw new Error('任务类型无效');
  const cancel=new SharedArrayBuffer(4),flag=new Int32Array(cancel);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./job-thread.mjs',import.meta.url),{workerData:{request,cancel}});
    active.add(worker);let result,workerError;
    const abort=()=>Atomics.store(flag,0,1);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    worker.on('message',event=>{if(event.type==='complete')result=event;else onEvent(event);});
    worker.once('error',error=>{workerError=error;});
    worker.once('exit',code=>{
      active.delete(worker);signal?.removeEventListener('abort',abort);
      if(code!==0||!result)reject(new Error(workerError?'Node.js 解密线程异常：'+workerError.message:'Node.js 解密线程未返回结果'));
      else resolve(result);
    });
  });
}
