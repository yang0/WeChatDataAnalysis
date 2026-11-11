# 微信解密 · Magpie Node.js 插件

将微信 4.x 加密数据库转换为普通 SQLite。**无需 Python、pip、虚拟环境，也无需自己启动后台服务。**

## 安装与使用

在 Magpie「插件 → 发现」输入：

```text
github:yang0/WeChatDataAnalysis
```

启用后打开「微信解密」：

1. 选择微信账号的 `db_storage` 目录。
2. 选择一个独立输出目录。
3. 填入 64 位十六进制数据库密钥；Windows x64 也可以展开自动获取区域，确认保存内容后重启微信、完成登录以获取密钥。
4. 点击「开始解密」，查看进度、逐文件错误和结果路径。停止任务时，当前尚未完成的文件会清理，已成功的文件保留。

每次任务创建独立结果目录，保留原始相对路径。输出包括明文 `.db` 和完整结果报告 `report.json`。部分消息字段仍可能压缩或使用结构化编码；本插件不提供聊天 TXT 导出、媒体解密、聊天分析或实时同步。

默认 `main` 是插件，原完整应用在 [`original-app`](https://github.com/yang0/WeChatDataAnalysis/tree/original-app)。`magpie-plugin` 保留为旧安装地址的兼容分支。

## 本地 checkout

```sh
git clone https://github.com/yang0/WeChatDataAnalysis.git magpie-wechat-decrypt
cd magpie-wechat-decrypt
```

已有仓库：

```sh
git fetch origin
git switch main
git pull --ff-only origin main
```

在 Magpie 的安装输入框填写本地目录完整路径也可以，例如 `D:/code/magpie-wechat-decrypt`。更新本地代码后重新加载插件/重启 Magpie。原完整应用用 `git switch original-app`。

## 运行方式

- **Magpie 内使用：**由 Magpie 自带的 Bun 插件宿主运行，无需额外安装 Node.js、Bun 或 Python。
- **独立开发：**Node.js 22.13+ 或当前 Bun。没有 npm 运行依赖，无需执行 `npm install`。
- 界面沿用 Magpie 官方插件页面/沙箱机制，轻量通信接口由插件管理，仅监听 `127.0.0.1:37987`；不需要单独部署 FastAPI、Electron 或其他服务。端口冲突时插件选项设为 `{"port":37989}` 后重启。
- 解密、PBKDF2-SHA512、AES-256-CBC、HMAC-SHA512 与 WAL 提交合并全部用 JavaScript / Node 内置 API 实现。文件逐页读写，计算在工作线程中进行，不把整个数据库加载进内存，不阻塞插件页面。
- SQLite 校验使用宿主内置引擎：Bun 的 `bun:sqlite` / Node 的 `node:sqlite`。通过真实 `PRAGMA quick_check` 和 schema 读取后才发布结果。
- Windows 自动获取密钥使用随插件提供的 x64 DLL，通过系统自带 PowerShell 调用。DLL 从固定版本 C++ 源码构建，**没有 Python DLL 依赖**，无需编译工具。仅在获取密钥时启动桥接进程，完成或取消后卸载 Hook。
- 其他系统可以填入已有密钥解密兼容数据库。微信 3.x 不在本版支持范围。自动取密钥的真实兼容性取决于当前微信版本，可能需要以管理员身份运行 Magpie。
- 旧版本留下的 Python 虚拟环境不会再被读取或启动，不需要为使用新版手动删除。

## 数据处理

处理本人或已获授权的数据。源数据库、WAL 只读；输出目录不能与源目录互相包含。密钥不写入命令行、环境变量、配置、日志或报告。自动获取的密钥仅保留在页面会话内存，可以清除。

每个数据库分别尝试已派生 AES key 和 SQLCipher passphrase/base key，以页面 HMAC 确认。WAL 仅合并校验正确的已提交事务；损坏 WAL、不完整页面、任何页面 HMAC 异常、SQLite 完整性错误、读取期间源文件变化均拒绝发布。检测到未处理的 rollback journal 时应正常退出微信后重试。

## 开发与测试

```sh
npm run check
npm test
npm pack --dry-run
```

Bun 宿主兼容测试：

```sh
bun test test
```

浏览器回归（仅开发时安装 Playwright）：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:ui
```

CI 在 Windows / Ubuntu、Node / Bun 四种组合下运行回归；额外执行 Windows DLL 编译、无 Python 依赖检查、真实/模拟 DLL ABI 探测及 Ubuntu 浏览器沙箱表单解密测试。固定加密测试向量由重写前的独立 Python 实现生成；测试和产品都无需运行 Python。

真实 Windows 微信密钥捕获与实际 Magpie 安装仍需用户本机验收，模拟测试不能替代当前微信版本的实测。

开发登记：[magpie-gptfree #20](https://github.com/yang0/magpie-gptfree/issues/20)。来源与授权情况：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
