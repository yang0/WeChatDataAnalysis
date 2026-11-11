import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorker } from './worker.mjs';
import { pickPath } from './native-dialog.mjs';
const GUI = join(dirname(fileURLToPath(import.meta.url)), '../gui');
export const GUI_PORT = 37987;
const MAX_BODY = 16384;
const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function textPath(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('请填写有效的' + name);
  return value.trim();
}
export function createService({ worker = runWorker, picker = pickPath, now = Date.now } = {}) {
  const sessions = new Map();
  let active = null, recent = null, discovery = null;
  const expiry = setInterval(() => {
    for (const [id, s] of sessions) if (s.expires < now() && !['running', 'canceling'].includes(s.job?.state)) { s.key = ''; sessions.delete(id); }
  }, 60000);
  expiry.unref();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const host = '127.0.0.1:' + server.address()?.port;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== 'null')) return json(res, 403, { error: '拒绝非本地插件请求' });
    if (req.headers.origin === 'null') {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-WeChat-Session');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const route = new URL(req.url, 'http://' + host).pathname;
    try {
      if (req.method === 'GET' && route === '/ui') {
        for (const [id, s] of sessions) if (s.expires < now() && s.job?.state !== 'running' && s.job?.state !== 'canceling') sessions.delete(id);
        if (sessions.size >= 32) return json(res, 429, { error: '页面过多，请稍后重试' });
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { expires: now() + 3600000, key: '', job: null });
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' http://${host}; style-src 'self' http://${host}; connect-src 'self' http://${host}; base-uri 'none'; object-src 'none'; form-action 'none'`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end((await readFile(join(GUI, 'page.html'), 'utf8')).replace('__SESSION__', id));
      }
      if (req.method === 'GET' && ['/assets/app.js', '/assets/style.css'].includes(route)) {
        const name = route.split('/').at(-1);
        res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
        return res.end(await readFile(join(GUI, name)));
      }
      const session = sessions.get(req.headers['x-wechat-session']);
      if (!session || (session.expires < now() && !['running', 'canceling'].includes(session.job?.state))) return json(res, 403, { error: '插件页面已过期，请重新打开' });
      session.expires = now() + 3600000;
      if (req.method === 'POST' && (req.headers.origin !== 'null' || !req.headers['content-type']?.startsWith('application/json'))) return json(res, 403, { error: '拒绝不受信任的请求' });
      if (route === '/api/discovery' && req.method === 'GET') return json(res, 200, { search: discovery });
      if (route === '/api/discovery/cancel' && req.method === 'POST') {
        if (discovery?.state === 'running') {
          discovery.state = 'canceling'; discovery.message = '正在停止搜索…'; discovery.controller.abort();
        }
        return json(res, 200, { ok: true });
      }
      if (route === '/api/discovery' && req.method === 'POST') {
        const data = await body(req);
        if (discovery && (['running', 'canceling'].includes(discovery.state) ||
            (!data.force && discovery.state === 'completed' && now() - discovery.finished < 60000))) {
          return json(res, 200, { id: discovery.id });
        }
        const search = { id: randomBytes(12).toString('hex'), state: 'running', accounts: [], message: '正在搜索微信数据目录…' };
        Object.defineProperty(search, 'controller', { value: new AbortController() });
        discovery = search;
        json(res, 202, { id: search.id });
        queueMicrotask(async () => {
          try {
            const result = await worker({ action: 'detect' }, { signal: search.controller.signal, onEvent(event) {
              if (event.type === 'progress') search.message = event.message;
              if (event.type === 'detected') {
                search.accounts = (event.accounts || []).slice(0, 200);
                search.exe = event.exe || '';
                search.notes = event.notes || [];
                search.partial = !!event.partial || (event.accounts || []).length > 200;
              }
            } });
            search.state = search.controller.signal.aborted ? 'canceled' : result.state;
          } catch {
            search.state = search.controller.signal.aborted ? 'canceled' : 'error';
          } finally { search.finished = now(); }
        });
        return;
      }
      if (route === '/api/status' && req.method === 'GET') {
        if (!session.job) session.job = active || (recent && now() - recent.started < 1800000 ? recent : null);
        return json(res, 200, { platform: process.platform, hasKey: !!session.key, busy: !!active, job: session.job });
      }
      if (route === '/api/pick' && req.method === 'POST') { const data = await body(req); return json(res, 200, { path: await picker(data.kind) }); }
      if (route === '/api/forget' && req.method === 'POST') { session.key = ''; return json(res, 200, { hasKey: false }); }
      if (route === '/api/cancel' && req.method === 'POST') {
        const job = session.job;
        if (job && ['running', 'canceling'].includes(job.state)) { job.state = 'canceling'; job.message = '正在取消并清理临时文件…'; job.controller.abort(); }
        return json(res, 200, { ok: true });
      }
      if (route === '/api/start' && req.method === 'POST') {
        const data = await body(req);
        if (active) return json(res, 409, { error: '已有任务正在执行，请等待完成或取消' });
        if (!['decrypt', 'capture', 'detect'].includes(data.action)) throw new Error('任务类型无效');
        const request = { action: data.action };
        if (data.action !== 'detect') request.source = textPath(data.source, '数据目录');
        if (data.action === 'decrypt') {
          request.output = textPath(data.output, '输出目录');
          request.key = String(data.key || session.key || '').trim();
          if (!/^[0-9a-f]{64}$/i.test(request.key)) throw new Error('请填写 64 位十六进制密钥，或先获取密钥');
        }
        if (data.action === 'capture') {
          if (process.platform !== 'win32') throw new Error('自动获取密钥目前仅支持 Windows');
          if (data.restart !== true) throw new Error('请勾选同意重启微信');
          request.restart = true;
          request.exe = data.exe ? textPath(data.exe, '微信程序路径') : '';
          session.key = '';
        }
        const job = { started: now(), id: randomBytes(12).toString('hex'), action: data.action, state: 'running', done: 0, total: 0, successful: 0, failed: 0, events: [], message: '正在启动…' };
        Object.defineProperty(job, 'controller', { value: new AbortController() });
        session.job = active = recent = job;
        json(res, 202, { id: job.id });
        queueMicrotask(async () => {
          try {
            const result = await worker(request, { signal: job.controller.signal, onEvent(event) {
              if (event.type === 'key') { if (/^[0-9a-f]{64}$/i.test(event.key)) session.key = event.key; return; }
              if (event.type === 'started') job.message = '正在解密并校验数据库…';
              if (event.type === 'complete') return; // Only mark done after the worker has closed.
              if (event.type === 'detected') { job.candidates = event.candidates; job.exe = event.exe; }
              for (const field of ['done', 'total', 'successful', 'failed', 'output', 'file', 'message']) if (event[field] !== undefined) job[field] = event[field];
              if (event.type === 'failure') job.message = event.message;
              if (event.type === 'file') {
                job.events.push({ file: event.file, success: event.success, error: event.error, wal_pages: event.wal_pages, ...(event.zero_pages ? { zero_pages: event.zero_pages } : {}), ...(event.trimmed_zero_pages ? { trimmed_zero_pages: event.trimmed_zero_pages } : {}) });
                if (job.events.length > 200) job.events.shift();
              }
            } });
            for (const key of ['state', 'total', 'successful', 'failed', 'output']) if (result[key] !== undefined) job[key] = result[key];
            if (job.controller.signal.aborted) job.state = 'canceled';
            if (job.state === 'running') { job.state = 'error'; job.message = '任务未返回有效状态'; }
            if (job.action === 'capture' && job.state !== 'completed') session.key = '';
          } catch (error) {
            job.state = job.controller.signal.aborted ? 'canceled' : 'error';
            job.message = String(error.message || '任务失败').replaceAll(request.key || '\u0000', '[密钥已隐藏]').slice(0, 500);
            if (job.action === 'capture') session.key = '';
          } finally { request.key = ''; if (active === job) active = null; }
        });
        return;
      }
      return json(res, 404, { error: '接口不存在' });
    } catch (error) { if (!res.headersSent) json(res, 400, { error: String(error.message || '请求无效').slice(0, 500) }); }
  });
  server.on('close', () => { clearInterval(expiry); active?.controller.abort(); discovery?.controller.abort(); for (const session of sessions.values()) session.key = ''; sessions.clear(); });
  return server;
}
let instance;
export async function startService(port = GUI_PORT) {
  if (instance) { if (instance.address()?.port !== port) throw new Error('微信解密插件已在其他端口启动，请重启 Magpie'); return instance; }
  const server = createService();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  server.unref();
  instance = server;
  return server;
}
