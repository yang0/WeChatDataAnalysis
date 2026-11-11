import { parentPort, workerData } from 'node:worker_threads';
import { decryptJob } from './decrypt.mjs';
const canceled=new Int32Array(workerData.cancel);
try {
  const result=await decryptJob(workerData.request,{emit:event=>parentPort.postMessage(event),checkCanceled:()=>{if(Atomics.load(canceled,0))throw new Error('任务已取消');}});
  parentPort.postMessage({type:'complete',...result});
}catch(error){
  parentPort.postMessage({type:'failure',message:String(error.message||'解密失败').replaceAll(workerData.request.key||'\0','[密钥已隐藏]').slice(0,500)});
  parentPort.postMessage({type:'complete',state:Atomics.load(canceled,0)?'canceled':'error'});
}finally{workerData.request.key='';parentPort.close();}
