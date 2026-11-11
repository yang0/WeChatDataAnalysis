# Sources and notices

## JavaScript database implementation

The SQLCipher 4.x/WCDB parameters, raw/base key compatibility, committed WAL rules and source-stability checks follow the original `yang0/WeChatDataAnalysis` implementation at commit `fffe9ca2bdb27f786227cff9d3620940ad8c034c` (forked from `LifeArchiveProject/WeChatDataAnalysis`). Version 0.2 rewrites the implementation in JavaScript; the Python source, bytecode, requirements and wheels are removed. Independent synthetic encrypted test vectors generated before removal are retained under `test/fixtures.json`; no user data is included.

The original source has no root license declaring a general redistribution grant at the inspected revision. This same-repository derivative preserves attribution and lineage; package.json remains UNLICENSED rather than assigning a blanket license to upstream work.

## Magpie

The manifest and page/bootstrap integration follow official `yetone/magpie` plugin page documentation and the author's `yang0/magpie-gptfree` integration. Magpie's Bun host runs Node-compatible APIs. SQLite uses the runtime's bundled engine. No npm runtime dependencies, Python runtime, model weights or full application UI are bundled.

## Windows key component

`native/win32-x64/wx_key.dll` is built from `H3CoF6/py_wx_key` commit `f32e146647380a6ee14791cc5d4e279f9c480a41`, excluding pybind11 and Python headers/libraries. Source: https://github.com/H3CoF6/py_wx_key/tree/f32e146647380a6ee14791cc5d4e279f9c480a41 . See native/UPSTREAM.md for the exact ABI, source files and source/license boundary. Its bundled upstream MinHook and Xbyak components retain their upstream terms. The Windows DLL and manifest are generated and ABI-tested in CI, then included in the installable plugin. SHA-256 is checked before native loading.

The PowerShell/C# bridge is isolated to a short-lived process, relies on Windows-provided components, and does not load .pyd files or Python DLLs. Real account key capture is not covered by fake-process/ABI tests.
