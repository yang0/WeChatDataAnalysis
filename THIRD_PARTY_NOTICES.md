# Sources and third-party notices

## WeChatDataAnalysis subset

The following files are extracted from `yang0/WeChatDataAnalysis` (`main`, commit `fffe9ca2bdb27f786227cff9d3620940ad8c034c`), a fork of `LifeArchiveProject/WeChatDataAnalysis`:

- `python/wechat_decrypt_tool/wechat_decrypt.py`
- `python/wechat_decrypt_tool/sqlite_wal.py`
- `python/wechat_decrypt_tool/sqlite_diagnostics.py`
- `python/wechat_decrypt_tool/database_filters.py`

The only plugin-specific change inside these extracted files is a cooperative cancellation check in the per-page decryption loop. `app_paths.py` and `logging_config.py` are small standalone adapters; other original application services are not bundled.

The original source repository has no root LICENSE declaring a general redistribution license at the inspected revision. This dedicated branch preserves the source repository lineage and attribution. `package.json` therefore uses `UNLICENSED`; no new MIT or other blanket license is claimed for extracted code. Any future external distribution must resolve the upstream licensing terms.

## Magpie integration reference

The package manifest, sandboxed page bootstrap, loopback UI architecture and Python virtual-environment pattern were implemented with reference to `yang0/magpie-gptfree` (package metadata declares MIT) and the official `yetone/magpie` plugin page documentation. GPT account, authentication, model and image-generation code is not included.

## Runtime dependencies

- cryptography — https://github.com/pyca/cryptography — Apache-2.0 OR BSD-3-Clause.
- psutil (optional Windows key acquisition) — https://github.com/giampaolo/psutil — BSD-3-Clause.
- wx_key (optional Windows key acquisition) — wrapper releases: https://github.com/H3CoF6/py_wx_key/releases/ ; underlying component: https://github.com/ycccccccy/wx_key . The existing CPython 3.11–3.14 Windows x64 wheels from the same inspected WeChatDataAnalysis commit are retained under `python/key_wheels` and installed on demand. Their distribution terms are not re-licensed here. This plugin uses the original initialize/poll/cleanup API.

Dependencies are installed into a separate local virtual environment. No user databases, keys, media, machine credentials, native-core license mechanisms, model weights or upstream UI bundles are included. The optional wx_key wheels are the only bundled native key-capture dependency.
