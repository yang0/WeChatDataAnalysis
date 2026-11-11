import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptJob, decryptDatabase } from '../lib/decrypt.mjs';
import { normalizeKey } from '../lib/crypto.mjs';
import { openDatabase } from '../lib/sqlite.mjs';
import { runWorker } from '../lib/worker.mjs';
const fixture=JSON.parse(await readFile(new URL('./fixtures.json',import.meta.url),'utf8'));
async function setup(t,encoded='raw'){
  const root=await mkdtemp(join(tmpdir(),'wechat-node-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'数据');await mkdir(source);
  await writeFile(join(source,'message.db'),Buffer.from(fixture[encoded],'base64'));
  return {root,source,output:join(root,'输出'),key:fixture.key};
}
async function message(file){const db=await openDatabase(file);try{return db.prepare('SELECT content FROM messages').get().content;}finally{db.close();}}
for(const mode of ['raw','passphrase'])test(`independent Python-generated ${mode} SQLCipher vector decrypts to real readable SQLite`,async t=>{
  const req=await setup(t,mode);const before=await readFile(join(req.source,'message.db'));
  const result=await decryptJob(req);
  assert.equal(result.state,'completed');assert.equal(result.successful,1);
  assert.equal(await message(join(result.output,'message.db')),'你好，微信');
  assert.deepEqual(await readFile(join(req.source,'message.db')),before);
  assert.equal((await readFile(join(result.output,'report.json'),'utf8')).includes(fixture.key),false);
});
test('encrypted committed WAL restores latest Chinese message; uncommitted tail ignored',async t=>{
  const req=await setup(t);const data=Buffer.concat([Buffer.from(fixture.updatedWal,'base64'),Buffer.from('incomplete-tail')]);
  await writeFile(join(req.source,'message.db-wal'),data);
  const result=await decryptJob(req);
  assert.equal(result.state,'completed');assert.equal(await message(join(result.output,'message.db')),'最新消息');
  assert.deepEqual(await readFile(join(req.source,'message.db-wal')),data);
});
for(const kind of ['key','hmac','wal','sqlite'])test(`${kind} corruption rejected with no output database`,async t=>{
  const req=await setup(t);
  if(kind==='key')req.key='ab'.repeat(32);
  if(kind==='hmac'){const b=Buffer.from(fixture.raw,'base64');b[b.length-1]^=1;await writeFile(join(req.source,'message.db'),b);}
  if(kind==='wal'){const b=Buffer.from(fixture.updatedWal,'base64');b[b.length-10]^=1;await writeFile(join(req.source,'message.db-wal'),b);}
  if(kind==='sqlite'){
    // Plain SQLite input still goes through the actual SQLite integrity checker.
    const valid=await decryptJob({...req});const b=await readFile(join(valid.output,'message.db'));b[100]=0xff;await writeFile(join(req.source,'message.db'),b);
  }
  const result=await decryptJob(req);assert.equal(result.state,'error');assert.equal(result.failed,1);
  assert.deepEqual((await readdir(result.output)).filter(x=>x.endsWith('.db')||x.endsWith('.partial')),[]);
});
test('relative subdirectories retained; output/source overlap and symlink escape refused',async t=>{
  const req=await setup(t);
  for(const output of [req.source,join(req.source,'out'),req.root])await assert.rejects(decryptJob({...req,output}),/不能相同或互相包含/);
  await mkdir(join(req.source,'message'));await writeFile(join(req.source,'message','message.db'),Buffer.from(fixture.raw,'base64'));
  if(process.platform!=='win32'){await symlink(join(req.source,'message.db'),join(req.source,'link.db'));}
  const result=await decryptJob(req);assert.equal(result.total,2);assert.equal(result.successful,2);
  assert.equal(await message(join(result.output,'message','message.db')),'你好，微信');
});
test('changing source during a read fails before publishing and cleans partial file',async t=>{
  const req=await setup(t);const dest=join(req.root,'out.db');let changed;
  await assert.rejects(decryptDatabase(join(req.source,'message.db'),dest,normalizeKey(req.key),{onPages:()=>{changed=writeFile(join(req.source,'message.db-wal'),'x');},validate:async()=>{await changed;}}),/发生变化/);
  await assert.rejects(readFile(dest));await assert.rejects(readFile(dest+'.partial'));
});
test('cooperative cancel before publication discards current database',async t=>{
  const req=await setup(t);let cancel=false;
  const result=await decryptJob(req,{emit:e=>{if(e.type==='progress'&&e.message)cancel=true;},checkCanceled:()=>{if(cancel)throw new Error('canceled');}});
  assert.equal(result.state,'canceled');assert.equal(result.successful,0);assert.deepEqual(await readdir(result.output),['report.json']);
});
test('actual Node/Bun worker thread returns readable DB without any Python process',async t=>{
  const req=await setup(t);const events=[];const result=await runWorker({action:'decrypt',...req},{onEvent:e=>events.push(e)});
  assert.equal(result.state,'completed');assert.equal(await message(join(result.output,'message.db')),'你好，微信');
  assert.equal(JSON.stringify(events).includes(fixture.key),false);
});
test('symlink WAL rejected without opening its target',async t=>{
  if(process.platform==='win32')return;
  const req=await setup(t);await writeFile(join(req.root,'external-wal'),'hello');await symlink(join(req.root,'external-wal'),join(req.source,'message.db-wal'));
  const result=await decryptJob(req);assert.equal(result.state,'error');
});
