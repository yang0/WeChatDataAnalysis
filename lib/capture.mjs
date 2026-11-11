import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { listDatabases } from './decrypt.mjs';
import { normalizeKey, resolveKey, eraseKeys, SQLITE_HEADER } from './crypto.mjs';
const ROOT=join(dirname(fileURLToPath(import.meta.url)),'../native');
const DLL=join(ROOT,'win32-x64/wx_key.dll');
const processes=new Set();process.once('exit',()=>{for(const p of processes)p.kill();});
export function nativeCommand({signal,onEvent=()=>{},find=false,request={},dll=DLL,probe=false}={}) {
  return new Promise((resolvePromise,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(ROOT,'key-bridge.ps1'),'-DllPath',dll,...(find?['-FindOnly']:[]),...(probe?['-ProbeOnly']:[])],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    processes.add(child);const decoder=new StringDecoder('utf8');let buffer='',result,found='',key='',stderrSize=0,killTimer;
    const abort=()=>{child.stdin.write('{"cancel":true}\n');killTimer??=setTimeout(()=>child.kill(),12000);};
    const deadline=setTimeout(()=>{child.kill();},115000);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{
      buffer+=decoder.write(chunk);
      if(buffer.length>65536){child.kill();return;}
      let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{
        const e=JSON.parse(line);
        if(e.type==='key'){if(/^[0-9a-f]{64}$/i.test(e.key))key=e.key;}
        else if(e.type==='complete')result=e;
        else if(e.type==='found'){found=e.exe;result={state:'completed'};}
        else if(e.type==='probe')result=e;
        else onEvent(e);
      }catch{/* Native library diagnostics are never echoed or logged. */}}
    });
    child.stderr.on('data',b=>{stderrSize+=b.length;if(stderrSize>65536)child.kill();});
    function cleanup(){clearTimeout(deadline);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);processes.delete(child);}
    child.once('error',()=>{cleanup();reject(new Error('Windows 密钥桥接无法启动，请确认 PowerShell 可用'));});
    child.once('close',code=>{cleanup();if(signal?.aborted)resolvePromise({state:'canceled'});else if(!result)reject(new Error('Windows 密钥桥接异常退出'));else resolvePromise({...result,key,exe:found,exitCode:code});});
    child.stdin.write(JSON.stringify(request)+'\n');if(signal?.aborted)abort();
  });
}
export async function findWeChat(signal){if(process.platform!=='win32')return '';return (await nativeCommand({signal,find:true})).exe||'';}
export async function verifyCapturedKey(source,key){
  const material=normalizeKey(key);
  try {
    for(const path of await listDatabases(await import('node:fs/promises').then(fs=>fs.realpath(source)))){
      const file=await open(path,'r');try{const page=Buffer.alloc(4096);const {bytesRead}=await file.read(page,0,4096,0);if(bytesRead!==4096||page.subarray(0,16).equals(SQLITE_HEADER))continue;try{const keys=resolveKey(material,page);eraseKeys(keys);return true;}catch{/* Try another database from the selected account. */}}finally{await file.close();}
    }
    return false;
  }finally{material.fill(0);}
}
export async function captureKey(request,{signal,onEvent=()=>{},command=nativeCommand,verify=verifyCapturedKey,platform=process.platform,arch=process.arch,verifyBinary=true}={}){
  if(platform!=='win32'||arch!=='x64')throw new Error('自动获取密钥目前仅支持 Windows x64；其他系统可填写已有密钥');
  if(request.restart!==true)throw new Error('请先勾选同意重启微信');
  if(verifyBinary){
    const manifest=JSON.parse(await readFile(join(ROOT,'manifest.json'),'utf8'));
    const bytes=await readFile(DLL).catch(()=>{throw new Error('缺少 Windows 密钥组件，请重新安装插件');});
    if(createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('Windows 密钥组件校验失败，请重新安装插件');
  }
  const result=await command({request,signal,onEvent});
  if(result.state==='completed'){
    if(!result.key||!await verify(request.source,result.key))throw new Error('获取的密钥与所选数据目录不匹配，请确认微信账号和目录一致');
    if(signal?.aborted)return {state:'canceled'};
    onEvent({type:'key',key:result.key});
  }
  result.key='';return {state:result.state};
}
