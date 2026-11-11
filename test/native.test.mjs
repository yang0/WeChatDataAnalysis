import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { nativeCommand } from '../lib/capture.mjs';
const dll=new URL('../native/win32-x64/wx_key.dll',import.meta.url);
const available=await access(dll).then(()=>true,()=>false);
test('bundled native component matches recorded SHA-256 and pinned source', {skip:!available},async()=>{
  const manifest=JSON.parse(await readFile(new URL('../native/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.commit,'f32e146647380a6ee14791cc5d4e279f9c480a41');
  assert.equal(manifest.sha256,createHash('sha256').update(await readFile(dll)).digest('hex'));
});
test('packaged DLL loads through actual Node/Bun → PowerShell → C ABI bridge', {skip:!available||process.platform!=='win32'},async()=>{
  const result=await nativeCommand({probe:true});
  assert.equal(result.ok,true);assert.equal(result.exitCode,0);assert.equal(result.sample,'');
});
