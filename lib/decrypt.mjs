import { open, lstat, stat, realpath, readdir, mkdir, mkdtemp, rm, rename, writeFile } from 'node:fs/promises';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { normalizeKey, resolveKey, decryptPage, eraseKeys, PAGE_SIZE, SQLITE_HEADER } from './crypto.mjs';
import { readExact, indexWal } from './wal.mjs';
import { validateSQLite } from './sqlite.mjs';
const ignored=name=>['key_info.db','chat_search_index.db','chat_search_index.tmp.db'].includes(name.toLowerCase())||name.toLowerCase().endsWith('_fts.db');
// path.sep is needed here, independently of the drive reported by path.parse.
export function containsPath(parent, child) { const r=relative(parent,child);return r===''||(!/^\.\.(?:[\\/]|$)/.test(r)&&!isAbsolute(r)); }
async function canonicalNew(path) {
  let current=resolve(path);const rest=[];
  while(true) { try { return join(await realpath(current),...rest.reverse()); } catch(error) { if(error.code!=='ENOENT') throw error; const parent=dirname(current);if(parent===current) throw error;rest.push(current.slice(parent.length).replace(/^[\\/]+/,''));current=parent; } }
}
export async function listDatabases(root,checkCanceled=()=>{}) {
  const files=[];
  async function walk(dir) {
    checkCanceled();
    for(const e of await readdir(dir,{withFileTypes:true})) {
      const path=join(dir,e.name); const info=await lstat(path);
      if(info.isSymbolicLink()||!containsPath(root,await realpath(path))) continue;
      if(e.isDirectory()) await walk(path);
      else if(e.isFile()&&/\.db$/i.test(e.name)&&!ignored(e.name)) files.push(path);
    }
  }
  await walk(root);return files.sort();
}
async function snapshot(path) {
  try { const s=await lstat(path,{bigint:true});if(s.isSymbolicLink()||!s.isFile()) throw new Error('拒绝读取数据库或 WAL 符号链接/特殊文件');return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':'); }
  catch(e){if(e.code==='ENOENT') return '';throw e;}
}
async function signature(path) { return Promise.all(['','-wal','-journal'].map(suffix=>snapshot(path+suffix))).then(a=>a.join('|')); }
export async function decryptDatabase(source,destination,material,{checkCanceled=()=>{},onPages=()=>{},validate=validateSQLite}={}) {
  let db,wal,out,keys;let publish=false,created=false;
  const temporary=destination+'.partial';
  try {
    if(resolve(source)===resolve(destination))throw new Error('解密输出不能覆盖源数据库');
    if(await stat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))throw new Error('输出数据库已经存在');
    const before=await signature(source);
    if(!before.split('|')[0]) throw new Error('源数据库不存在');
    const journal=await stat(source+'-journal').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(journal?.size) throw new Error('检测到未处理的 rollback journal，请正常退出微信后重试');
    db=await open(source,'r');
    const original=await db.stat();
    const header=await readExact(db,100,0);
    const plaintext=header.subarray(0,16).equals(SQLITE_HEADER);
    let pageSize=plaintext?header.readUInt16BE(16):PAGE_SIZE;if(pageSize===1)pageSize=65536;
    if(pageSize<512||pageSize>65536||(pageSize&(pageSize-1))||original.size%pageSize) throw new Error('数据库页大小无效或文件存在不完整页面');
    if(!original.size)throw new Error('数据库为空');
    if(!plaintext)keys=resolveKey(material,await readExact(db,PAGE_SIZE,0));
    try{wal=await open(source+'-wal','r');}catch(e){if(e.code!=='ENOENT')throw e;}
    const walSize=wal?(await wal.stat()).size:0;
    const index=await indexWal(wal,walSize,pageSize,original.size/pageSize,checkCanceled);
    await mkdir(dirname(destination),{recursive:true});
    out=await open(temporary,'wx',0o600);created=true;
    for(let n=1;n<=index.size;n++) {
      checkCanceled();
      const offset=index.pages.get(n);
      if(offset===undefined&&n>index.basePages)throw new Error('WAL 缺少有效提交页面');
      const page=await readExact(offset===undefined?db:wal,pageSize,offset===undefined?(n-1)*pageSize:offset);
      const plain=plaintext?page:decryptPage(page,n,keys);
      if(n===1) {
        if(!plain.subarray(0,16).equals(SQLITE_HEADER))throw new Error('解密结果不是 SQLite 数据库');
        plain[18]=1;plain[19]=1;
        if(index.info.committed_frames)plain.writeUInt32BE(index.size,28);
      }
      let written=0;
      while(written<plain.length){const {bytesWritten}=await out.write(plain,written,plain.length-written);if(!bytesWritten)throw new Error('输出写入失败');written+=bytesWritten;}
      if(n%256===0||n===index.size) onPages(n,index.size);
    }
    await out.sync();await out.close();out=null;
    checkCanceled();
    await validate(temporary);
    if(before!==await signature(source))throw new Error('源数据库或 WAL 在读取期间发生变化，请退出微信后重试');
    checkCanceled();
    await rename(temporary,destination);publish=true;
    return {wal_pages:index.info.applied_pages,key_mode:plaintext?'plain_sqlite':keys.mode};
  }finally{
    eraseKeys(keys);await db?.close();await wal?.close();await out?.close();
    if(!publish&&created)await rm(temporary,{force:true});
  }
}
export async function decryptJob(request,{emit=()=>{},checkCanceled=()=>{}}={}) {
  if(!request.source||!request.output)throw new Error('请选择数据目录与输出目录');
  const source=await realpath(request.source),output=await canonicalNew(request.output);
  if(!(await stat(source)).isDirectory())throw new Error('请选择存在的微信账号数据目录');
  if(containsPath(source,output)||containsPath(output,source))throw new Error('输出目录与源目录不能相同或互相包含，请选择独立目录');
  const material=normalizeKey(request.key);let run;
  try {
    const files=await listDatabases(source,checkCanceled);
    if(!files.length)throw new Error('目录内没有可解密的 .db 文件；当前支持微信 4.x');
    await mkdir(output,{recursive:true});run=await mkdtemp(join(output,'wechat-'));
    emit({type:'started',total:files.length,output:run});
    let successful=0,failed=0,canceled=false;const rows=[];
    for(let i=0;i<files.length;i++) {
      try{checkCanceled();}catch{canceled=true;break;}
      const file=relative(source,files[i]);const destination=join(run,file);
      emit({type:'progress',done:i,total:files.length,file});
      let row;
      try {
        const detail=await decryptDatabase(files[i],destination,material,{checkCanceled,onPages:(page,pages)=>emit({type:'progress',message:`正在校验 ${file}：${page} / ${pages} 页`})});
        successful++;row={file,success:true,error:'',...detail};
      }catch(error){
        try{checkCanceled();}catch{canceled=true;break;}
        failed++;row={file,success:false,error:String(error.message||'解密失败').replaceAll(String(request.key),'[密钥已隐藏]').slice(0,500),wal_pages:0};
      }
      rows.push(row);emit({type:'file',...row,done:i+1,total:files.length,successful,failed});
    }
    const state=canceled?'canceled':failed?(successful?'partial':'error'):'completed';
    const result={state,total:files.length,successful,failed,output:run};
    await writeFile(join(run,'report.json'),JSON.stringify({...result,files:rows},null,2),{mode:0o600});
    return result;
  }finally{material.fill(0);request.key='';}
}
