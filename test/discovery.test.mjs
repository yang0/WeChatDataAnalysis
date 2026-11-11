import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAccounts, configBase, decodeConfig, windowsLocations } from '../lib/discovery.mjs';
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'wechat-discovery-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'profile');await mkdir(home);
  return {root,home,env:{},platform:'linux'};
}
async function account(base,name,withDb=true){
  const path=join(base,name,'db_storage');await mkdir(join(path,'message'),{recursive:true});
  if(withDb)await writeFile(join(path,'message','message_0.db'),'filename-only fixture');
  return realpath(path);
}
async function config(root,value){
  const appdata=join(root,'AppData','Roaming'),dir=join(appdata,'Tencent','xwechat','config');
  await mkdir(dir,{recursive:true});
  const name=createHash('md5').update('KEY_LAST_XWEACHAT_FILE_DIR').digest('hex')+'.ini';
  await writeFile(join(dir,name),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(value,'utf16le')]));
  return appdata;
}
test('finds a usable account db_storage without reporting empty accounts or parent directories',async t=>{
  const options=await setup(t),base=join(options.home,'Documents','xwechat_files');
  const path=await account(base,'wxid_test');await account(base,'empty',false);
  const result=await discoverAccounts(options);
  assert.deepEqual(result.candidates,[path]);assert.equal(result.accounts[0].account,'wxid_test');assert.equal(result.accounts[0].source,'默认路径');
});
test('Windows UTF-16 config locates an arbitrary custom data folder outside Documents',async t=>{
  const options=await setup(t),custom=join(options.root,'D 盘','工作备份','深层目录','微信数据');
  const path=await account(join(custom,'xwechat_files'),'wxid_custom');
  const appdata=await config(options.root,custom);
  const result=await discoverAccounts({...options,platform:'win32',env:{APPDATA:appdata},locations:async()=>({drives:[]})});
  assert.deepEqual(result.candidates,[path]);assert.equal(result.accounts[0].source,'微信配置');
});
test('redirected Documents and registry discovery find multiple accounts and deduplicate canonical paths',async t=>{
  const options=await setup(t),documents=join(options.root,'OneDrive','Documents');
  const base=join(documents,'xwechat_files'),first=await account(base,'wxid_one'),second=await account(base,'wxid_two');
  const result=await discoverAccounts({...options,platform:'win32',env:{OneDrive:join(options.root,'OneDrive')},locations:async()=>({documents,roots:[documents,base,documents],exe:'C:\\Weixin.exe'})});
  assert.deepEqual(new Set(result.candidates),new Set([first,second]));assert.equal(result.accounts.length,2);assert.equal(result.exe,'C:\\Weixin.exe');
});
test('bounded fixed-disk fallback finds xwechat_files below a custom parent without scanning system directories',async t=>{
  const options=await setup(t),drive=join(options.root,'local-drive');
  const found=await account(join(drive,'备份','wechatMSG','xwechat_files'),'wxid_disk');
  await account(join(drive,'Windows','xwechat_files'),'excluded');
  const result=await discoverAccounts({...options,platform:'win32',locations:async()=>({drives:[drive]})});
  assert.deepEqual(result.candidates,[found]);assert.equal(result.accounts[0].source,'磁盘搜索');
});
test('missing or inaccessible Windows settings do not prevent default directory discovery',async t=>{
  const options=await setup(t),path=await account(join(options.home,'Documents','xwechat_files'),'default');
  const result=await discoverAccounts({...options,platform:'win32',locations:async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});}});
  assert.deepEqual(result.candidates,[path]);assert.match(result.notes.join(' '),/系统路径查询未完成/);
});
test('search marks bounded results partial and responds to cancellation',async t=>{
  const options=await setup(t);await account(join(options.home,'Documents','xwechat_files'),'test');
  const result=await discoverAccounts({...options,maxDirectories:1});assert.equal(result.partial,true);assert.equal(result.scanned,1);
  const controller=new AbortController();
  await assert.rejects(discoverAccounts({...options,signal:controller.signal,onProgress:()=>controller.abort()}),/取消/);
});
test('does not traverse a directory symlink discovered during fallback scan',async t=>{
  if(process.platform==='win32')return;
  const options=await setup(t);const external=join(options.root,'outside');
  await account(join(external,'xwechat_files'),'outside');await symlink(external,join(options.home,'redirect'));
  assert.deepEqual((await discoverAccounts(options)).candidates,[]);
});
test('config decoding handles UTF-16 BE and Windows Documents tokens and rejects UNC',()=>{
  const bytes=Buffer.concat([Buffer.from([0xfe,0xff]),Buffer.from('MyDocument:32773','utf16le').swap16()]);
  assert.equal(configBase(decodeConfig(bytes),{platform:'win32',documents:'D:\\文档'}),'D:\\文档');
  assert.equal(configBase('%USERPROFILE%\\微信',{platform:'win32',env:{UserProfile:'C:\\用户'}}),'C:\\用户\\微信');
  assert.equal(configBase('\\\\server\\share',{platform:'win32'}),'');
});

test('Windows system locator returns paths from the real PowerShell bridge', {skip:process.platform!=='win32'}, async()=>{
  const result=await windowsLocations();
  assert.equal(typeof result.documents,'string');assert.equal(typeof result.exe,'string');
  assert.ok(Array.isArray(result.roots));assert.ok(Array.isArray(result.drives));
});
