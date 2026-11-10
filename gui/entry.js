(async () => {
  const state = document.querySelector('#state');
  const retry = document.querySelector('#retry');
  retry.onclick = () => location.reload();
  try {
    await magpie.ready;
    const options = await magpie.options.get();
    const port = Number(options?.port ?? 37987);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('插件端口无效');
    const base = magpie.service || `http://127.0.0.1:${port}/`;
    const target = new URL('ui', base);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('插件服务地址无效');
    setTimeout(() => { state.textContent = '尚未连接，请确认插件已启用，或检查端口是否被占用。'; retry.hidden = false; }, 6000);
    location.replace(target.href);
  } catch (error) { state.textContent = '连接失败：' + error.message; retry.hidden = false; }
})();
