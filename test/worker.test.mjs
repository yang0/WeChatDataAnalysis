import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorker } from '../lib/worker.mjs';
import { pickPath } from '../lib/native-dialog.mjs';

test('Python process protocol works without HTTP or shell', async () => {
  const events=[];
  const result = await runWorker({action:'detect'}, {python:async()=>process.env.TEST_PYTHON || 'python',onEvent:e=>events.push(e)});
  assert.equal(result.state,'completed');
  assert.ok(events.some(e=>e.type==='detected'));
});

test('native picker uses separate arguments and treats cancellation correctly', async () => {
  let spec;
  const path = await pickPath('folder',{platform:'win32',runner:async(bin,args,options)=>{spec={bin,args,options};return {stdout:'C:\\数据\\账号\r\n'};}});
  assert.equal(path,'C:\\数据\\账号');
  assert.equal(spec.options.shell,false);
  assert.equal(spec.bin,'powershell.exe');
  assert.equal(await pickPath('folder',{runner:async()=>{throw Object.assign(new Error(),{code:1});}}),'');
});
