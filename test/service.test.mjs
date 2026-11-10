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
