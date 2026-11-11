import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptJob, decryptDatabase } from '../lib/decrypt.mjs';
import { normalizeKey, macKey, pageHmac, PAGE_SIZE, isZeroPage, lockBytePageNumber } from '../lib/crypto.mjs';
import { checksum } from '../lib/wal.mjs';
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
  assert.equal(result.state,'completed',await readFile(join(result.output,'report.json'),'utf8'));assert.equal(result.successful,1);
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

test('AbortSignal reaches a running worker and removes the current partial database',async t=>{
  const req=await setup(t);await rm(join(req.source,'message.db'));
  const db=await openDatabase(join(req.source,'message.db'),{readonly:false});
  try{db.exec('CREATE TABLE payload(content BLOB); BEGIN');const insert=db.prepare('INSERT INTO payload VALUES (?)');for(let i=0;i<512;i++)insert.run(Buffer.alloc(8192,i%255));db.exec('COMMIT');}finally{db.close();}
  const controller=new AbortController();let sawPages=false;
  const result=await runWorker({action:'decrypt',...req},{signal:controller.signal,onEvent:e=>{if(e.type==='progress'&&e.message){sawPages=true;controller.abort();}}});
  assert.equal(sawPages,true);assert.equal(result.state,'canceled');assert.equal(result.successful,0);
  assert.deepEqual(await readdir(result.output),['report.json']);
});
test('output symlink overlap is rejected after canonicalizing existing ancestors',async t=>{
  if(process.platform==='win32')return;
  const req=await setup(t);const alias=join(req.root,'alias');await symlink(req.source,alias);
  await assert.rejects(decryptJob({...req,output:join(alias,'new-output')}),/不能相同或互相包含/);
});
function encryptPlainPage(plainPage,pageNumber,encKey,mac,salt){
  const iv=randomBytes(16);
  const cipher=createCipheriv('aes-256-cbc',encKey,iv);
  cipher.setAutoPadding(false);
  const body=Buffer.concat([cipher.update(plainPage.subarray(pageNumber===1?16:0,4016)),cipher.final()]);
  const out=Buffer.alloc(PAGE_SIZE);
  if(pageNumber===1)salt.copy(out,0);
  body.copy(out,pageNumber===1?16:0);
  iv.copy(out,4016);
  pageHmac(out,pageNumber,mac).copy(out,4032);
  return out;
}
function encryptPlainDb(plainDb,rawKey,{zeroPages=new Set()}={}){
  const salt=randomBytes(16),mac=macKey(rawKey,salt);
  const total=plainDb.length/PAGE_SIZE,chunks=[];
  for(let n=1;n<=total;n++){
    if(zeroPages.has(n)){chunks.push(Buffer.alloc(PAGE_SIZE));continue;}
    chunks.push(encryptPlainPage(plainDb.subarray((n-1)*PAGE_SIZE,n*PAGE_SIZE),n,rawKey,mac,salt));
  }
  return {encrypted:Buffer.concat(chunks),salt,mac};
}
function buildEncryptedWal(frames,dbSizePages,salt,{littleEndian=true}={}){
  const head=Buffer.alloc(32);
  head.writeUInt32BE(littleEndian?0x377f0682:0x377f0683,0);
  head.writeUInt32BE(3007000,4);head.writeUInt32BE(PAGE_SIZE,8);head.writeUInt32BE(1,12);
  salt.copy(head,16,0,8);
  let state=checksum(head.subarray(0,24),littleEndian);
  head.writeUInt32BE(state[0],24);head.writeUInt32BE(state[1],28);
  const parts=[head];
  for(let i=0;i<frames.length;i++){
    const {pgno,page,commit}=frames[i];
    const fh=Buffer.alloc(24);
    fh.writeUInt32BE(pgno,0);fh.writeUInt32BE(commit?dbSizePages:0,4);salt.copy(fh,8,0,8);
    state=checksum(page,littleEndian,checksum(fh.subarray(0,8),littleEndian,state));
    fh.writeUInt32BE(state[0],16);fh.writeUInt32BE(state[1],20);
    parts.push(fh,page);
  }
  return Buffer.concat(parts);
}
async function createReservedPlainDb(path,build){
  let db=await openDatabase(path,{readonly:false});
  try{db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; CREATE TABLE _i(x); DROP TABLE _i;');}finally{db.close();}
  const init=Buffer.from(await readFile(path));init[20]=80;await writeFile(path,init);
  db=await openDatabase(path,{readonly:false});
  try{db.exec('VACUUM;');await build(db);}finally{db.close();}
  return Buffer.from(await readFile(path));
}
test('trailing preallocated all-zero pages without WAL decrypt cleanly and keep integrity',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wechat-pad-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'数据'),output=join(root,'输出');await mkdir(source);
  const padded=Buffer.concat([Buffer.from(fixture.raw,'base64'),Buffer.alloc(150*PAGE_SIZE)]);
  await writeFile(join(source,'message.db'),padded);
  const result=await decryptJob({source,output,key:fixture.key});
  assert.equal(result.state,'completed');assert.equal(result.successful,1);
  assert.equal(await message(join(result.output,'message.db')),'你好，微信');
  const report=JSON.parse(await readFile(join(result.output,'report.json'),'utf8'));
  assert.equal(report.files[0].zero_pages,150);assert.equal(report.files[0].trimmed_zero_pages,0);
});
test('chunk-padded WAL db_size with trailing unused zero pages trims tail after SQLite verification',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wechat-walpad-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'数据'),output=join(root,'输出'),seed=join(root,'seed.db');await mkdir(source);
  const plainDb=await createReservedPlainDb(seed,db=>{
    db.exec("CREATE TABLE messages(content TEXT); INSERT INTO messages VALUES ('旧消息');");
  });
  const logicalPages=plainDb.length/PAGE_SIZE,rawKey=normalizeKey(fixture.key);
  const {encrypted,salt,mac}=encryptPlainDb(plainDb,rawKey);
  const paddedPages=logicalPages+150;
  await writeFile(join(source,'message.db'),Buffer.concat([encrypted,Buffer.alloc(150*PAGE_SIZE)]));
  const walSeed=join(root,'walseed.db');await writeFile(walSeed,plainDb);
  const db2=await openDatabase(walSeed,{readonly:false});
  try{db2.exec("UPDATE messages SET content='WAL新消息';");}finally{db2.close();}
  const updatedBytes=await readFile(walSeed);
  const walFrames=[];
  for(let n=1;n<=logicalPages;n++){
    const a=plainDb.subarray((n-1)*PAGE_SIZE,n*PAGE_SIZE),b=updatedBytes.subarray((n-1)*PAGE_SIZE,n*PAGE_SIZE);
    if(!a.equals(b))walFrames.push({pgno:n,page:encryptPlainPage(b,n,rawKey,mac,salt)});
  }
  assert.ok(walFrames.length>0);
  walFrames[walFrames.length-1].commit=true;
  await writeFile(join(source,'message.db-wal'),buildEncryptedWal(walFrames,paddedPages,randomBytes(8)));
  const events=[];
  const result=await decryptJob({source,output,key:fixture.key},{emit:e=>events.push(e)});
  assert.equal(result.state,'completed',await readFile(join(result.output,'report.json'),'utf8'));
  assert.equal(await message(join(result.output,'message.db')),'WAL新消息');
  const outInfo=await stat(join(result.output,'message.db'));
  assert.equal(outInfo.size,logicalPages*PAGE_SIZE);
  const report=JSON.parse(await readFile(join(result.output,'report.json'),'utf8'));
  assert.equal(report.files[0].zero_pages,150);assert.equal(report.files[0].trimmed_zero_pages,150);
  assert.ok(events.some(e=>e.type==='file'&&e.trimmed_zero_pages===150));
});
test('all-zero freelist leaf pages are preserved without false truncation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wechat-free-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'数据'),output=join(root,'输出'),seed=join(root,'seed.db');await mkdir(source);
  const plainDb=await createReservedPlainDb(seed,db=>{
    db.exec('CREATE TABLE messages(content TEXT); CREATE TABLE trash(pad BLOB); BEGIN;');
    const ins=db.prepare('INSERT INTO trash VALUES (?)');
    for(let i=0;i<24;i++)ins.run(Buffer.alloc(1800,0x41));
    db.exec("INSERT INTO messages VALUES ('保留空闲页'); COMMIT; DROP TABLE trash;");
  });
  const trunkPage=plainDb.readUInt32BE(32),freeCount=plainDb.readUInt32BE(36);
  assert.ok(trunkPage>=2&&freeCount>=2);
  const trunkOff=(trunkPage-1)*PAGE_SIZE,leafCount=plainDb.readUInt32BE(trunkOff+4);
  const zeroPages=new Set();
  for(let i=0;i<leafCount;i++)zeroPages.add(plainDb.readUInt32BE(trunkOff+8+i*4));
  // Remove trunk page itself just in case, keep leaf pages unencrypted all-zero.
  zeroPages.delete(trunkPage);
  assert.ok(zeroPages.size>=1);
  const {encrypted}=encryptPlainDb(plainDb,normalizeKey(fixture.key),{zeroPages});
  await writeFile(join(source,'message.db'),encrypted);
  const result=await decryptJob({source,output,key:fixture.key});
  assert.equal(result.state,'completed',await readFile(join(result.output,'report.json'),'utf8'));
  assert.equal(await message(join(result.output,'message.db')),'保留空闲页');
  assert.equal((await stat(join(result.output,'message.db'))).size,plainDb.length);
  const report=JSON.parse(await readFile(join(result.output,'report.json'),'utf8'));
  assert.equal(report.files[0].zero_pages,zeroPages.size);assert.equal(report.files[0].trimmed_zero_pages,0);
});
test('interior corruption and non-zero HMAC errors are still strictly rejected even with trailing zero pages',async t=>{
  const root=await mkdtemp(join(tmpdir(),'wechat-reject-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const seed=join(root,'seed.db');
  const plainDb=await createReservedPlainDb(seed,db=>{
    db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, content TEXT); BEGIN;');
    const ins=db.prepare('INSERT INTO messages(content) VALUES (?)');
    for(let i=0;i<60;i++)ins.run('消息行-'+i+'-'+'x'.repeat(200));
    db.exec('COMMIT;');
  });
  const logicalPages=plainDb.length/PAGE_SIZE;
  assert.ok(logicalPages>=4);
  // Case 1: interior page zeroed + trailing zero tail + inflated WAL db_size must still fail.
  const {encrypted:enc1}=encryptPlainDb(plainDb,normalizeKey(fixture.key),{zeroPages:new Set([2])});
  const s1=join(root,'s1'),o1=join(root,'o1');await mkdir(s1);
  await writeFile(join(s1,'message.db'),Buffer.concat([enc1,Buffer.alloc(20*PAGE_SIZE)]));
  const r1=await decryptJob({source:s1,output:o1,key:fixture.key});
  assert.equal(r1.state,'error');assert.equal(r1.failed,1);
  // Case 2: non-zero byte inside trailing tail fails HMAC immediately.
  const s2=join(root,'s2'),o2=join(root,'o2');await mkdir(s2);
  const tail=Buffer.alloc(5*PAGE_SIZE);tail[tail.length-1]=1;
  await writeFile(join(s2,'message.db'),Buffer.concat([Buffer.from(fixture.raw,'base64'),tail]));
  const r2=await decryptJob({source:s2,output:o2,key:fixture.key});
  assert.equal(r2.state,'error');assert.match((await readFile(join(r2.output,'report.json'),'utf8')),/HMAC 校验失败/);
  // Case 3: WAL frame all-zero is rejected by WAL checksum/HMAC, never bypassed as preallocation.
  const s3=join(root,'s3'),o3=join(root,'o3');await mkdir(s3);
  await writeFile(join(s3,'message.db'),Buffer.from(fixture.raw,'base64'));
  await writeFile(join(s3,'message.db-wal'),buildEncryptedWal([{pgno:2,page:Buffer.alloc(PAGE_SIZE),commit:true}],2,randomBytes(8)));
  const r3=await decryptJob({source:s3,output:o3,key:fixture.key});
  assert.equal(r3.state,'error');
  assert.equal(isZeroPage(Buffer.alloc(PAGE_SIZE)),true);
  assert.equal(lockBytePageNumber(PAGE_SIZE),262145);
});
