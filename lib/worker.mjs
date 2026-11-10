import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PYDIR = join(dirname(fileURLToPath(import.meta.url)), '../python');
const ROOT = process.env.MAGPIE_WECHAT_HOME || join(homedir(), '.magpie-wechat-decrypt');
const VENV = join(ROOT, 'venv');
const BIN = join(VENV, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const active = new Set();
process.once('exit', () => { for (const child of active) child.kill(); });
let preparation = Promise.resolve();
const exists = async p => { try { await access(p); return true; } catch { return false; } };

function command(bin, args, signal, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    active.add(child);
    let out = '', size = 0;
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 65536) child.kill(); });
    child.stderr.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) child.kill(); });
    child.once('error', () => { clearTimeout(timer); active.delete(child); reject(new Error('无法启动 Python，请安装 Python 3.11+，或设置 MAGPIE_WECHAT_PYTHON')); });
    child.once('close', code => { clearTimeout(timer); active.delete(child); code === 0 ? resolve(out.trim()) : reject(new Error('Python 环境准备失败，请检查 Python、网络和 pip（自动密钥组件需 Windows x64 / Python 3.11–3.14）；可用 MAGPIE_WECHAT_PYTHON 指向已安装依赖的解释器')); });
  });
}

async function prepare(keys, signal) {
  const custom = process.env.MAGPIE_WECHAT_PYTHON;
  const probe = ['-c', 'import sys; assert sys.version_info >= (3,11); import cryptography' + (keys ? '; import psutil, wx_key' : '')];
  if (custom) { await command(custom, probe, signal, 20000); return custom; }
  if (!await exists(BIN)) {
    await mkdir(ROOT, { recursive: true, mode: 0o700 });
    const candidates = process.platform === 'win32' ? [['py', '-3.11'], ['py', '-3.12'], ['py', '-3.13'], ['py', '-3.14'], ['py', '-3'], ['python']] : [['python3'], ['python']];
    let base;
    for (const [bin, ...prefix] of candidates) {
      try { await command(bin, [...prefix, '-c', 'import sys; assert sys.version_info >= (3,11)'], signal, 15000); base = [bin, prefix]; break; } catch { if (signal?.aborted) throw new Error('已取消'); }
    }
    if (!base) throw new Error('未找到 Python 3.11+。请先安装 Python，再重新运行插件');
    await command(base[0], [...base[1], '-m', 'venv', VENV], signal);
  }
  try { await command(BIN, probe, signal, 20000); }
  catch {
    if (signal?.aborted) throw new Error('已取消');
    await command(BIN, ['-m', 'pip', 'install', '--disable-pip-version-check', '--find-links', join(PYDIR, 'key_wheels'), '-r', join(PYDIR, 'requirements.txt'), ...(keys ? ['-r', join(PYDIR, 'requirements-keys.txt')] : [])], signal);
    await command(BIN, probe, signal, 20000);
  }
  return BIN;
}
export function ensurePython(keys, signal) {
  // A canceled first job must not poison subsequent environment setup.
  const next = preparation.catch(() => {}).then(() => prepare(keys, signal));
  preparation = next;
  return next;
}

export async function runWorker(request, { signal, onEvent = () => {}, python = ensurePython } = {}) {
  if (request.action === 'capture' && process.platform !== 'win32') throw new Error('自动获取密钥仅支持 Windows；请填写已有密钥');
  onEvent({ type: 'progress', message: '正在检查 Python 环境（首次运行会自动安装所需依赖）…' });
  const bin = await python(request.action === 'capture', signal);
  if (signal?.aborted) return { state: 'canceled' };
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [join(PYDIR, 'worker.py')], { shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' } });
    active.add(child);
    const decoder = new StringDecoder('utf8');
    let buffer = '', result = null, runDir = '', stderrBytes = 0, cancelTimer, protocolError = false;
    const cancel = () => {
      child.stdin.write('{"cancel":true}\n');
      cancelTimer ??= setTimeout(() => child.kill(), 15000);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) child.kill(); });
    child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (buffer.length > 1024 * 1024) { protocolError = true; child.kill(); return; }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'started') runDir = event.output;
          if (event.type === 'complete') result = event;
          onEvent(event);
        } catch { protocolError = true; child.kill(); }
      }
    });
    child.once('error', () => { cleanup(); reject(new Error('解密子进程无法启动')); });
    function cleanup() { clearTimeout(cancelTimer); signal?.removeEventListener('abort', cancel); active.delete(child); }
    child.once('close', async code => {
      cleanup();
      if (runDir) {
        try { for (const entry of await readdir(runDir, { withFileTypes: true })) {
          if (entry.name.startsWith('.staging-')) await rm(join(runDir, entry.name), { recursive: true, force: true });
        } } catch { /* Do not mask the job result if a user moved the output. */ }
      }
      if (signal?.aborted) resolve({ ...result, state: 'canceled' });
      else if (code !== 0 || protocolError || !result) reject(new Error('解密子进程异常退出；可能是内存不足或运行环境不完整，请重试或缩小目录范围'));
      else resolve(result);
    });
    // Key goes through a pipe, never argv, environment, options or disk.
    child.stdin.write(JSON.stringify(request) + '\n');
    if (signal?.aborted) cancel();
  });
}
