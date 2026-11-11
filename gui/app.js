const $ = id => document.getElementById(id);
const session = document.querySelector('meta[name=session]').content;
let busy = false, submitting = false;
let sourceRevision = 0, discoveryRequest = null, renderedDiscovery = null, discoveryPending = false, didAutoSearch = false;
const labels = { idle: '待开始', running: '进行中', canceling: '取消中', canceled: '已停止', completed: '已完成', partial: '部分失败', error: '失败' };
async function api(path, data) {
  const response = await fetch('api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-WeChat-Session': session, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '插件请求失败');
  return result;
}
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
function lock(value) {
  busy = value;
  for (const el of document.querySelectorAll('.form input,.form button:not(#detect):not(#stop-detect)')) el.disabled = value;
  $('cancel').disabled = !value;
}
async function start(action) {
  if (submitting || busy) return;
  submitting = true; lock(true); error('');
  try {
    await api('start', { action, source: $('source').value, output: $('output').value,
      key: $('key').value, exe: $('exe').value, restart: $('restart').checked });
    $('key').value = ''; $('key').type = 'password'; $('reveal').textContent = '显示'; $('reveal').setAttribute('aria-pressed', 'false');
    await refresh();
  } catch (e) { error(e.message); lock(false); }
  finally { submitting = false; }
}
function render(data) {
  const job = data.job;
  lock(data.busy || submitting);
  $('automatic').hidden = data.platform !== 'win32';
  $('key-state').textContent = data.hasKey ? '已获取密钥，可直接开始解密。密钥仅保留在当前页面会话内存中。' : '密钥仅用于当前页面任务，不写入配置或报告。';
  $('key').placeholder = data.hasKey ? '已获取密钥（填写新值可覆盖）' : '填写 64 位十六进制密钥';
  if (!job) return;
  $('state').textContent = labels[job.state] || job.state;
  const terminal = !['running', 'canceling'].includes(job.state);
  $('message').textContent = terminal && job.state !== 'error'
    ? ({ completed: job.action === 'capture' ? '密钥已获取，可以开始解密。' : job.action === 'detect' ? '已完成微信目录搜索。' : '解密完成，文件已通过校验。', canceled: '任务已停止。已完成的数据库仍保留在结果目录。', partial: '部分数据库解密失败，请查看下方错误与 report.json。' }[job.state] || job.message || '')
    : job.message || '正在处理…';
  $('done').textContent = `${job.done || 0} / ${job.total || 0}`;
  $('successful').textContent = job.successful || 0; $('failed').textContent = job.failed || 0;
  if (job.state === 'running' && !job.total) $('progress').removeAttribute('value');
  else { $('progress').max = Math.max(job.total || 0, 1); $('progress').value = job.done || 0; }
  $('current').textContent = job.file || '';
  $('destination').hidden = !job.output; $('output-result').value = job.output || '';
  $('events').replaceChildren();
  for (const event of job.events || []) {
    const row = document.createElement('div'); row.className = 'event' + (event.success ? '' : ' bad');
    const badge = document.createElement('strong'); badge.textContent = event.success ? '成功 · ' : '失败 · ';
    row.append(badge, document.createTextNode(event.file + (event.error ? '：' + event.error : event.wal_pages ? ` · 已合并 ${event.wal_pages} 个 WAL 页` : '')));
    $('events').append(row);
  }
  if (job.state === 'error') error(job.message || '全部数据库解密失败，请核对密钥、微信版本和下方文件错误。');
}
function setSource(path) { $('source').value = path; sourceRevision++; markSelected(); }
function markSelected() {
  for (const button of $('candidates').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.path === $('source').value));
  }
}
$('source').addEventListener('input', () => { sourceRevision++; markSelected(); });
async function beginDiscovery(force) {
  if (discoveryPending) return;
  discoveryPending = true;
  const revision = sourceRevision;
  $('detect').disabled = true;
  $('discovery-state').textContent = '正在搜索微信数据目录…';
  try {
    const result = await api('discovery', { force });
    discoveryRequest = { id: result.id, revision };
    renderDiscovery((await api('discovery')).search);
  } catch (e) { $('discovery-state').textContent = '无法自动搜索，请手动选择目录。'; $('detect').disabled = false; }
  finally { discoveryPending = false; }
}
function renderDiscovery(search) {
  if (!search) return;
  const running = ['running', 'canceling'].includes(search.state);
  $('detect').disabled = running;
  $('stop-detect').hidden = !running;
  $('stop-detect').disabled = search.state === 'canceling';
  if (running) { $('discovery-state').textContent = search.message; return; }
  if (search.state !== 'completed') {
    $('discovery-state').textContent = search.state === 'canceled' ? '搜索已停止。可重新搜索或手动选择。' : '无法自动搜索，请手动选择目录。';
    return;
  }
  if (search.exe && !$('exe').value) $('exe').value = search.exe;
  const accounts = search.accounts || [];
  if (accounts.length === 1 && !$('source').value.trim() && discoveryRequest?.id === search.id && discoveryRequest.revision === sourceRevision) {
    setSource(accounts[0].path);
  }
  const summary = accounts.length === 1 ? '已找到 1 个微信账号。' : accounts.length > 1 ? `已找到 ${accounts.length} 个微信账号，请选择。` : '未找到微信账号目录，可手动选择 db_storage。';
  $('discovery-state').textContent = [summary, ...(search.notes || [])].join(' ');
  if (renderedDiscovery === search.id) { markSelected(); return; }
  renderedDiscovery = search.id;
  $('candidates').replaceChildren();
  for (const account of accounts) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.path = account.path; button.disabled = busy;
    const name = document.createElement('strong'); name.textContent = account.account;
    const detail = document.createElement('small'); detail.textContent = account.path + (account.source ? ' · ' + account.source : '');
    button.append(name, detail); button.onclick = () => setSource(account.path); $('candidates').append(button);
  }
  markSelected();
}
async function refresh() {
  const [status, found] = await Promise.all([api('status'), api('discovery')]);
  render(status); renderDiscovery(found.search);
  if (!didAutoSearch) { didAutoSearch = true; void beginDiscovery(false); }
}
$('decrypt').onclick = () => start('decrypt'); $('capture').onclick = () => start('capture'); $('detect').onclick = () => beginDiscovery(true);
$('stop-detect').onclick = async () => { try { await api('discovery/cancel', {}); } catch { } };
$('cancel').onclick = async () => { try { $('cancel').disabled = true; await api('cancel', {}); await refresh(); } catch (e) { error(e.message); } };
$('forget').onclick = async () => { try { $('key').value = ''; await api('forget', {}); await refresh(); } catch (e) { error(e.message); } };
$('reveal').onclick = () => { const show = $('key').type === 'password'; $('key').type = show ? 'text' : 'password'; $('reveal').textContent = show ? '隐藏' : '显示'; $('reveal').setAttribute('aria-pressed', String(show)); };
for (const button of document.querySelectorAll('[data-pick]')) button.onclick = async () => { try { button.disabled = true; const result = await api('pick', { kind: button.dataset.pick === 'exe' ? 'exe' : 'folder' }); if (result.path) { if (button.dataset.pick === 'source') setSource(result.path); else $(button.dataset.pick).value = result.path; } } catch (e) { error(e.message); } finally { button.disabled = busy; } };
async function poll() {
  try { await refresh(); } catch (e) { error(e.message); }
  setTimeout(poll, document.hidden ? 4000 : 900);
}
poll();
