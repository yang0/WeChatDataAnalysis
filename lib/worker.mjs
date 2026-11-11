import { Worker } from 'node:worker_threads';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureKey, findWeChat } from './capture.mjs';
const active=new Set();process.once('exit',()=>{for(const worker of active)worker.terminate();});
export async function detectDirectories({home=homedir()}={}) {
  const candidates=[];
  for(const root of [join(home,'Documents','xwechat_files'),join(home,'xwechat_files'),join(home,'Documents','WeChat Files')]) {
    try {
      const dirs=await readdir(root,{withFileTypes:true});const accounts=[];
      for(const d of dirs)if(d.isDirectory()){const path=join(root,d.name,'db_storage');if((await stat(path).catch(()=>null))?.isDirectory())accounts.push(path);}
      candidates.push(...(accounts.length?accounts.sort():[root]));
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return candidates;
}
export async function runWorker(request,{signal,onEvent=()=>{}}={}) {
  if(signal?.aborted)return {state:'canceled'};
  if(request.action==='detect'){
    const candidates=await detectDirectories();const exe=process.platform==='win32'?await findWeChat(signal).catch(()=>''):'';
    onEvent({type:'detected',candidates,exe});return {state:'completed'};
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
