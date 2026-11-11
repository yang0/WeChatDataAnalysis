import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createService } from '../lib/service.mjs';
import { openDatabase } from '../lib/sqlite.mjs';
import { discoverAccounts } from '../lib/discovery.mjs';
import { runWorker } from '../lib/worker.mjs';
const root=await mkdtemp(join(tmpdir(),'wechat-ui-'));
const home=join(root,'profile'),base=join(home,'Documents','xwechat_files');
const source=join(base,'wxid_first','db_storage'),output=join(root,'输出');await mkdir(source,{recursive:true});
const fixture=JSON.parse(await readFile(new URL('./fixtures.json',import.meta.url),'utf8'));
await writeFile(join(source,'message.db'),Buffer.from(fixture.raw,'base64'));
let releaseSearch, delayedSearch;
const service=createService({worker:async(request,ctx)=>{
  if(request.action!=='detect')return runWorker(request,ctx);
  if(delayedSearch)await delayedSearch;
  ctx.onEvent({type:'detected',...await discoverAccounts({home,env:{},platform:'linux',signal:ctx.signal})});
  return {state:'completed'};
}});await new Promise(r=>service.listen(0,'127.0.0.1',r));
const parent=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<html><body style="margin:0"><iframe title="微信解密" sandbox="allow-scripts" src="http://127.0.0.1:${service.address().port}/ui" style="width:100%;height:100vh;border:0"></iframe></body></html>`);});
await new Promise(r=>parent.listen(0,'127.0.0.1',r));
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{} )});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+parent.address().port);
  const ui=page.frameLocator('iframe');
  await ui.locator('#discovery-state').filter({hasText:'已找到 1 个微信账号'}).waitFor();
  assert.equal(await ui.locator('#source').inputValue(),source);
  await ui.locator('#output').fill(output);await ui.locator('#key').fill(fixture.key);await ui.locator('#decrypt').click();
  await ui.locator('#state').filter({hasText:'已完成'}).waitFor({timeout:20000});
  assert.equal(await ui.locator('#successful').innerText(),'1');
  const result=await ui.locator('#output-result').inputValue();const db=await openDatabase(join(result,'message.db'));
  try{assert.equal(db.prepare('SELECT content FROM messages').get().content,'你好，微信');}finally{db.close();}
  const artifacts=process.env.UI_ARTIFACTS||root;await mkdir(artifacts,{recursive:true});
  await page.screenshot({path:join(artifacts,'desktop.png'),fullPage:true});
  await ui.locator('#key').fill('bad-key');await ui.locator('#decrypt').click();await ui.locator('#error').filter({hasText:'64 位'}).waitFor();
  // A running automatic search must leave manual inputs and the prior result intact.
  delayedSearch=new Promise(resolve=>{releaseSearch=resolve;});
  await ui.locator('#source').fill('');await ui.locator('#detect').click();
  await ui.locator('#stop-detect').waitFor({state:'visible'});
  const manual=join(root,'手填目录');await ui.locator('#source').fill(manual);
  delayedSearch=null;releaseSearch();
  await ui.locator('#discovery-state').filter({hasText:'已找到 1 个微信账号'}).waitFor();
  assert.equal(await ui.locator('#source').inputValue(),manual);
  assert.equal(await ui.locator('#output-result').inputValue(),result);
  const second=join(base,'wxid_second','db_storage');await mkdir(second,{recursive:true});
  await writeFile(join(second,'message.db'),Buffer.from(fixture.raw,'base64'));
  await ui.locator('#detect').click();await ui.locator('#discovery-state').filter({hasText:'已找到 2 个微信账号'}).waitFor();
  await ui.locator('#candidates button').filter({hasText:'wxid_second'}).click();
  assert.equal(await ui.locator('#source').inputValue(),second);
  await page.setViewportSize({width:420,height:1000});await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true});
  const widths=await ui.locator('body').evaluate(e=>[e.scrollWidth,e.clientWidth]);assert.ok(widths[0]<=widths[1]+1);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({sandbox_gui:'passed',auto_fill_single_account:'passed',manual_path_preserved:'passed',choose_multiple_accounts:'passed',node_decryption:'passed',readable_sqlite:'passed',invalid_key_ui:'passed',browser_errors:errors}));
}finally{await browser?.close();await new Promise(r=>parent.close(r));await new Promise(r=>service.close(r));await rm(root,{recursive:true,force:true});}
