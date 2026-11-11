# 微信解密 · Magpie 插件

把微信 4.x 加密数据库转换为普通 SQLite。参考 `yang0/magpie-gptfree` 的插件页面集成，独立提取 `yang0/WeChatDataAnalysis` 的数据库解密部分。

## 安装

在 Magpie 的「插件 → 发现」底部输入：

```text
github:yang0/WeChatDataAnalysis
```

安装并启用后，打开「微信解密」。默认 `main` 分支是独立插件，原完整应用保存在 [`original-app`](https://github.com/yang0/WeChatDataAnalysis/tree/original-app) 分支。`magpie-plugin` 分支作为旧安装地址的兼容入口保留。

## 本地 checkout

首次下载插件：

```sh
git clone https://github.com/yang0/WeChatDataAnalysis.git magpie-wechat-decrypt
cd magpie-wechat-decrypt
```

已有仓库切到插件主分支：

```sh
git fetch origin
git switch main
git pull --ff-only origin main
```

如需原完整应用：

```sh
git fetch origin
git switch original-app
```

也可以在 Magpie「插件 → 发现」输入本地插件目录的完整路径安装。

## 使用

1. 选择自己的微信账号数据目录，推荐选择该账号的 `db_storage`。也可以点击「查找默认数据目录」。自定义存储位置可直接填写完整路径。
2. 选择一个独立的输出目录，不能与源目录相同或互相包含。
3. 填入已有的 64 位十六进制数据库密钥，或在 Windows 展开「没有密钥？从 Windows 微信获取」。自动获取会重启微信，界面要求先确认保存内容；随后在微信窗口完成登录。
4. 点击「开始解密」。每次生成一个独立结果目录，保留源文件的相对路径。界面显示每个文件的成功、失败原因与 WAL 合并情况；完整结果保存在 `report.json`。

结果是可以用 SQLite 工具读取的 `.db`，不是聊天记录 TXT。数据库内的部分消息字段仍可能使用压缩或结构化编码，需要额外解析才能整理成可读聊天记录。当前不包含图片、语音、视频解密，聊天分析、年度总结和实时同步。

## 运行环境

- Magpie 提供插件宿主，不需要安装 Electron、启动 FastAPI、配置 Docker 或另外运行服务。
- 本机需要 **Python 3.11+**。插件首次执行任务时，会自动在用户目录创建专属虚拟环境并安装 `cryptography`；Windows 获取密钥时额外安装 `psutil` 和 `wx_key`。依赖安装需要联网，数据库解密本身不上传数据。
- 没有 Python 时会给出明确错误。安装 Python 后重试即可；插件不会自动下载安装 Python 本体，也不会修改全局 Python 包。
- 自动获取密钥先支持 Windows x64 / Python 3.11–3.14（复用原仓库的预编译组件），可能需要以管理员身份启动 Magpie；兼容性取决于微信版本。macOS / Linux 可用已有正确密钥处理兼容的微信 4.x 数据库副本。微信 3.x 不在当前支持范围。
- 如需使用自己管理的解释器，启动 Magpie 前设置 `MAGPIE_WECHAT_PYTHON` 为已安装上述依赖的 Python 路径。`MAGPIE_WECHAT_HOME` 可修改插件专属环境目录。

### 关于“后台服务”

没有独立后台程序需要你启动。Magpie 的内嵌页面受沙箱限制，按照参考插件的方式，由插件宿主自动提供一个仅监听 `127.0.0.1:37987` 的轻量页面/通信接口。它随宿主运行，不采集消息、不做实时同步。

Python 只在执行任务时作为子进程启动，通过标准输入输出接收参数、报告进度，任务完成后退出。没有 FastAPI 或 Python HTTP 服务。端口冲突时可在插件选项里设置 `{"port":37989}`，然后重启 Magpie。

## 数据处理约定

- 仅处理本人或已获授权的数据库，源数据库与 WAL 只读；读取期间发生变化会拒绝该文件，请退出微信后再解密。
- 同时支持已派生 AES 密钥与 SQLCipher passphrase/base key；每个文件单独验证，密钥不匹配的文件显示失败，不会伪装为成功。
- 合并校验通过且已经提交的 WAL 帧；拒绝损坏 WAL、HMAC 异常及 SQLite 完整性错误。
- 结果发布前在独立临时目录中验证，不覆盖源文件和历史结果。
- 点击「停止任务」后按页检查取消状态，当前未发布的数据库会丢弃，已完成的文件保留；UI 显示清理中，直到子进程退出。
- 密钥通过管道传入，不放在命令行、环境变量、Magpie 配置或报告中。自动获取的密钥仅留在页面会话内存，可点「清除密钥」，过期后清除。重开页面可以查看/停止正在执行的任务，需重新获取或填写密钥才能开始新任务。
- GUI 保留最近 200 个文件结果，`report.json` 保留本次任务的完整文件结果。

## 开发与验证

```sh
python -m pip install -r python/requirements.txt
npm run check
npm test
npm run test:python
npm pack --dry-run
```

不需要 `npm install`，运行时没有 npm 第三方依赖。Python 运行依赖与测试代码分离。

浏览器沙箱回归（开发环境可选）：

```sh
python -m pip install playwright
python -m playwright install chromium
python test/ui_smoke.py
```

CI 在 Windows 和 Ubuntu 执行语法、接口、进程与加密数据库回归；Ubuntu 还验证实际 `sandbox="allow-scripts"` 页面中的表单、真实解密、错误提示与窄屏布局。

测试使用合成加密 SQLite 数据库，覆盖 raw key、passphrase、中文消息、加密 WAL、错误密钥、损坏 WAL、非首个页面 HMAC 异常、输出隔离、取消与原始数据保持不变。自动密钥捕获有模拟组件测试，**尚未在真实 Windows 微信及 Magpie 安装环境进行完整验收**。

开发登记：[magpie-gptfree #18](https://github.com/yang0/magpie-gptfree/issues/18)。

源码来源与授权情况见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
