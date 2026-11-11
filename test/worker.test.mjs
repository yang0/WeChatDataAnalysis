import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorker } from '../lib/worker.mjs';
import { captureKey } from '../lib/capture.mjs';
import { pickPath } from '../lib/native-dialog.mjs';

test('directory detection runs directly in JavaScript',async()=>{
  const events=[];const result=await runWorker({action:'detect'},{onEvent:e=>events.push(e)});
  assert.equal(result.state,'completed');assert.ok(events.some(e=>e.type==='detected'));
});
test('captured key validated before exposing to page and discarded after use',async()=>{
  const events=[];const result=await captureKey({source:'/data',restart:true},{platform:'win32',arch:'x64',verifyBinary:false,command:async()=>({state:'completed',key:'ab'.repeat(32)}),verify:async()=>true,onEvent:e=>events.push(e)});
  assert.equal(result.state,'completed');assert.equal(events[0].type,'key');assert.equal('key' in result,false);
});
test('capture mismatch, missing consent and non-Windows platform rejected',async()=>{
  const options={platform:'win32',arch:'x64',verifyBinary:false,command:async()=>({state:'completed',key:'ab'.repeat(32)}),verify:async()=>false};
  await assert.rejects(captureKey({restart:true},options),/不匹配/);
  await assert.rejects(captureKey({restart:false},options),/勾选/);
  await assert.rejects(captureKey({restart:true},{...options,platform:'linux'}),/Windows/);
});
test('native picker uses separate arguments and handles cancellation',async()=>{
  let spec;const path=await pickPath('folder',{platform:'win32',runner:async(bin,args,options)=>{spec={bin,args,options};return {stdout:'C:\\数据\\账号\r\n'};}});
  assert.equal(path,'C:\\数据\\账号');assert.equal(spec.options.shell,false);assert.equal(spec.bin,'powershell.exe');
  assert.equal(await pickPath('folder',{runner:async()=>{throw Object.assign(new Error(),{code:1});}}),'');
});
