import { startService, GUI_PORT } from './lib/service.mjs';
export const WeChatDecryptPlugin = async (_context, options = {}) => {
  const port = Number(options.port ?? GUI_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('微信解密插件端口无效');
  await startService(port);
  return {};
};
