import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readdir, stat, realpath, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve, isAbsolute, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const CONFIG_NAME = createHash('md5').update('KEY_LAST_XWEACHAT_FILE_DIR').digest('hex') + '.ini';
const DATA_NAMES = ['xwechat_files', 'WeChat Files'];
const SKIP = new Set(['windows','program files','program files (x86)','programdata','users','$recycle.bin','system volume information','recovery','node_modules','.git','appdata','filecache','filestorage','msgattach','video','image','cache','temp','all_users','all users','wmpf','applet']);
export async function windowsLocations({ signal, runner = exec } = {}) {
  const { stdout } = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../native/discover-paths.ps1', import.meta.url))], { shell: false, windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024, signal });
  return JSON.parse(String(stdout).replace(/^\ufeff/, '').trim());
}
export function decodeConfig(bytes) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { const body = Buffer.from(bytes.subarray(2, bytes.length - bytes.length % 2)); body.swap16(); text = body.toString('utf16le'); }
  else if (bytes.length > 2 && bytes[1] === 0 && bytes[3] === 0) text = bytes.toString('utf16le');
  else text = bytes.toString('utf8');
  return text.replace(/^\ufeff/, '').replace(/\0+$/g, '').trim();
}
export function configBase(text, { documents, env = process.env, platform = process.platform } = {}) {
  let value = String(text || '').trim().replace(/^"(.*)"$/, '$1');
  if (/^MyDocument(?::\d*)?$/i.test(value)) {
    const id = value.split(':')[1];
    return (!id || (Number(id) & 0xff) === 5) ? documents || '' : '';
  }
  value = value.replace(/%([^%]+)%/g, (all, name) => {
    const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? env[key] : all;
  });
  if (/^\\\\/.test(value)) return ''; // Avoid unbounded requests to network shares.
  return (platform === 'win32' ? win32.isAbsolute(value) : isAbsolute(value)) ? value : '';
}
export async function discoverAccounts({ home = homedir(), env = process.env, platform = process.platform, locations = windowsLocations, signal, onProgress = () => {}, maxDirectories = 6000, maxMs = 12000, now = Date.now } = {}) {
  const started = now();
  const checkCanceled = () => { if (signal?.aborted) throw new Error('搜索已取消'); };
  checkCanceled();
  let os = {}, partial = false;
  const notes = [];
  if (platform === 'win32') {
    try { os = await locations({ signal }); }
    catch { checkCanceled(); notes.push('系统路径查询未完成，已继续搜索默认位置'); }
  }
  checkCanceled();
  const documents = os.documents || join(home, 'Documents');
  const roots = [];
  const add = (path, source, depth) => {
    if (typeof path !== 'string' || !path.trim() || /[\0\r\n]/.test(path) || /^\\\\/.test(path)) return;
    roots.push({ path: resolve(path), source, remaining: depth });
  };
  const addDataRoot = (path, source) => {
    if (!path) return;
    add(path, source, 3);
    for (const name of DATA_NAMES) add(join(path, name), source, 3);
  };
  if (platform === 'win32' && env.APPDATA) {
    const path = join(env.APPDATA, 'Tencent', 'xwechat', 'config', CONFIG_NAME);
    try {
      const info = await stat(path);
      if (info.isFile() && info.size <= 65536) {
        const base = configBase(decodeConfig(await readFile(path)), { documents, env, platform });
        if (base) addDataRoot(base, '微信配置');
      }
    } catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) notes.push('部分微信配置无法读取'); }
  }
  for (const path of os.roots || []) addDataRoot(configBase(path, { documents, env, platform }), '微信注册表');
  for (const parent of [documents, home, env.USERPROFILE, env.OneDrive && join(env.OneDrive, 'Documents'), env.OneDriveConsumer && join(env.OneDriveConsumer, 'Documents'), env.OneDriveCommercial && join(env.OneDriveCommercial, 'Documents')]) {
    if (parent) for (const name of DATA_NAMES) add(join(parent, name), '默认路径', 3);
  }
  if (platform === 'darwin') {
    const container = join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data');
    add(join(container, 'Documents', 'xwechat_files'), '系统目录', 3);
    add(join(container, 'Library', 'Application Support', 'com.tencent.xinWeChat'), '系统目录', 5);
  }
  if (platform === 'linux') {
    for (const path of [join(home,'.xwechat'),join(home,'.local','share','WeChat')]) add(path, '系统目录', 4);
  }
  for (const path of [documents, join(home,'Desktop'), join(home,'Downloads'), home]) add(path, '常见位置', 2);
  for (const path of os.drives || []) add(path, '磁盘搜索', 2);
  const visited = new Map(), found = new Map();
  let scanned = 0, denied = 0, lastProgress = 0;
  const keyOf = path => platform === 'win32' ? path.toLowerCase() : path;
  async function hasDatabase(path, dirs) {
    if (dirs.some(d => d.isFile() && /\.db$/i.test(d.name))) return true;
    for (const d of dirs) if (d.isDirectory() && !d.isSymbolicLink()) {
      checkCanceled();
      if (now() - started >= maxMs) { partial = true; return false; }
      try { if ((await readdir(join(path,d.name),{withFileTypes:true})).some(e => e.isFile() && /\.db$/i.test(e.name))) return true; } catch { }
    }
    return false;
  }
  // Breadth-first traversal searches all fixed drives fairly, and never scans media beneath db_storage.
  for (let cursor = 0; cursor < roots.length; cursor++) {
    checkCanceled();
    if (scanned >= maxDirectories || now() - started >= maxMs) { partial = true; break; }
    const current = roots[cursor];
    let path;
    try { path = await realpath(current.path); } catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) denied++; continue; }
    const key = keyOf(path);
    if ((visited.get(key) ?? -1) >= current.remaining) continue;
    visited.set(key,current.remaining); scanned++;
    if (scanned === 1 || now() - lastProgress >= 300) { onProgress({ scanned, found: found.size }); lastProgress = now(); }
    let entries;
    try { entries = await readdir(path,{withFileTypes:true}); } catch { denied++; continue; }
    if (basename(path).toLowerCase() === 'db_storage') {
      if (!found.has(key) && await hasDatabase(path, entries)) {
        const info = await stat(path).catch(() => null);
        if (!info?.isDirectory()) continue;
        found.set(key,{ path, account:basename(dirname(path)), source:current.source, modifiedAt:info.mtimeMs });
      }
      continue;
    }
    for (const entry of entries) {
      if (roots.length >= maxDirectories * 4) { partial = true; break; }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const name = entry.name.toLowerCase();
      if (name === 'db_storage') roots.push({path:join(path,entry.name),source:current.source,remaining:0});
      else if (DATA_NAMES.some(n => n.toLowerCase() === name)) roots.push({path:join(path,entry.name),source:current.source,remaining:3});
      else if (current.remaining > 0 && !SKIP.has(name) && !name.startsWith('.')) roots.push({path:join(path,entry.name),source:current.source,remaining:current.remaining-1});
    }
  }
  checkCanceled();
  if (denied) notes.push('部分目录没有读取权限，已跳过');
  if (partial) notes.push('已达到搜索时间或目录上限，可重新搜索或手动选择');
  const priority = ['微信配置', '微信注册表', '默认路径', '系统目录', '常见位置', '磁盘搜索'];
  const accounts = [...found.values()].sort((a,b) => priority.indexOf(a.source)-priority.indexOf(b.source) || b.modifiedAt-a.modifiedAt || a.path.localeCompare(b.path));
  return { accounts, candidates:accounts.map(a=>a.path), exe:os.exe||'', partial, scanned, notes };
}
