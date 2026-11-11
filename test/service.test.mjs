import { request as httpRequest } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../lib/service.mjs';

async function setup(t, worker) {
  const server = createService({ worker, picker: async () => '/本地目录' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const html = await (await fetch(base + '/ui')).text();
  const token = html.match(/name="session" content="([a-f0-9]+)"/)[1];
  const api = (path, data, headers = {}) => fetch(base + '/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-WeChat-Session': token, ...(data === undefined ? {} : { Origin: 'null', 'Content-Type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { api, base, html, token };
}
async function until(api) {
  for (let i = 0; i < 100; i++) { const s = await (await api('status')).json(); if (!s.busy) return s; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Job did not settle');
}

test('API rejects untrusted origins, missing token and invalid host', async t => {
  let called = 0;
  const { api, base } = await setup(t, async () => { called++; });
  assert.equal((await fetch(base + '/api/status')).status, 403);
  assert.equal((await api('pick', {kind:'folder'}, {Origin:'https://evil.example'})).status, 403);
  assert.equal((await api('pick', {kind:'folder'}, {Origin:''})).status, 403);
  const hostStatus = await new Promise((resolve,reject) => { const req = httpRequest(base + '/ui', {headers:{Host:'evil.example'}}, res => { res.resume(); resolve(res.statusCode); }); req.on('error',reject); req.end(); });
  assert.equal(hostStatus, 403);
  assert.equal((await api('start', {action:'decrypt',source:'/a',output:'/b',key:'wrong'})).status, 400);
  assert.equal(called, 0);
  assert.equal((await api('pick', {kind:'folder'})).status, 200);
});

test('real job lifecycle, protocol progress and key do not leak to status', async t => {
  const key = 'ab'.repeat(32);
  const { api } = await setup(t, async (request, {onEvent}) => {
    assert.equal(request.key, key);
    onEvent({type:'key',key});
    onEvent({type:'started',total:2,output:'/results'});
    onEvent({type:'file',file:'message.db',success:true,done:1,successful:1});
    return {state:'partial',successful:1,failed:1,total:2,output:'/results'};
  });
  assert.equal((await api('start', {action:'decrypt',source:'/source',output:'/results',key})).status, 202);
  const result = await until(api);
  assert.equal(result.job.state, 'partial');
  assert.equal(result.hasKey,true);
  assert.equal(result.job.successful,1);
  assert.equal(JSON.stringify(result).includes(key),false);
  assert.equal(JSON.stringify(result).includes('controller'),false);
  await api('forget',{});
  assert.equal((await (await api('status')).json()).hasKey,false);
});

test('reopened page can recover and cancel active job; overlapping starts rejected', async t => {
  const { api, base } = await setup(t, async (_request,{signal,onEvent}) => {
    onEvent({type:'progress',message:'working'});
    await new Promise(resolve => signal.addEventListener('abort',resolve,{once:true}));
    return {state:'canceled'};
  });
  await api('start',{action:'detect'});
  assert.equal((await api('start',{action:'detect'})).status,409);
  const html = await (await fetch(base + '/ui')).text();
  const token = html.match(/name="session" content="([a-f0-9]+)"/)[1];
  const status = await (await api('status',undefined,{'X-WeChat-Session':token})).json();
  assert.equal(status.job.state,'running');
  await api('cancel',{}, {'X-WeChat-Session':token});
  assert.equal((await until(api)).job.state,'canceled');
});

test('worker error reports useful message and redacts supplied key', async t => {
  const key = 'cd'.repeat(32);
  const { api } = await setup(t, async () => { throw new Error('read failure: '+key); });
  await api('start',{action:'decrypt',source:'/source',output:'/result',key});
  const result = await until(api);
  assert.equal(result.job.state,'error');
  assert.match(result.job.message,/read failure/);
  assert.equal(JSON.stringify(result).includes(key),false);
});

test('oversized body rejected and filesystem picker input constrained', async t => {
  const { api } = await setup(t, async () => ({state:'completed'}));
  assert.equal((await api('start',{action:'detect',padding:'x'.repeat(20000)})).status,400);
  assert.equal((await api('start',{action:'decrypt',source:'/a\n/b',output:'/b',key:'00'.repeat(32)})).status,400);
});

async function waitSearch(api){
  for(let i=0;i<100;i++){
    const {search}=await (await api('discovery')).json();
    if(search&&!['running','canceling'].includes(search.state))return search;
    await new Promise(r=>setTimeout(r,5));
  }
  throw new Error('Search did not settle');
}
test('background account discovery is coalesced and does not replace the decryption result',async t=>{
  let calls=0;
  const {api}=await setup(t,async (request,{onEvent})=>{
    if(request.action==='detect'){
      calls++;onEvent({type:'detected',accounts:[{path:'/fixture/db_storage',account:'fixture'}]});
    }
    return {state:'completed',output:request.action==='decrypt'?'/result':undefined};
  });
  await api('start',{action:'decrypt',source:'/source',output:'/result',key:'ab'.repeat(32)});await until(api);
  assert.equal((await api('discovery',{})).status,202);const search=await waitSearch(api);
  assert.equal(search.accounts[0].path,'/fixture/db_storage');assert.equal('controller' in search,false);
  assert.equal((await api('discovery',{})).status,200);assert.equal(calls,1);
  assert.equal((await (await api('status')).json()).job.output,'/result');
  assert.equal((await api('discovery',{force:true})).status,202);await waitSearch(api);assert.equal(calls,2);
});
test('background search has independent cancellation',async t=>{
  const {api}=await setup(t,async (_request,{signal})=>{
    if(!signal.aborted)await new Promise(r=>signal.addEventListener('abort',r,{once:true}));
    return {state:'canceled'};
  });
  await api('discovery',{});assert.equal((await api('discovery/cancel',{})).status,200);
  assert.equal((await waitSearch(api)).state,'canceled');
  assert.equal((await (await api('status')).json()).busy,false);
});
