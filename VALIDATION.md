# Validation record

Implementation task: https://github.com/yang0/magpie-gptfree/issues/18

## Completed locally

- `npm run check`: passed.
- `npm test`: 7 tests passed (local API authorization, host/origin checks, job lifecycle, page recovery/cancel, error redaction, Python subprocess, native picker invocation).
- `npm run test:python`: 10 tests passed (real synthetic encrypted SQLite with readable Chinese messages, raw and derived keys, encrypted committed WAL recovery, HMAC/WAL corruption rejection, source/output isolation, cancellation, UTF-8 subprocess protocol, simulated Windows key capture with cleanup and consent).
- `npm pack --dry-run`: approximately 605 KiB packed / 691 KiB unpacked, 26 runtime files, no Python bytecode or test fixtures. Four original CPython Windows x64 key-capture wheels included; Python/installed dependencies are not included in this size.

## Browser and machine validation

`test/ui_smoke.py` exercises the actual sandboxed HTML page and real Python worker, and is configured in the dedicated branch's Ubuntu CI. Local Chromium could not start because this execution environment denies its process singleton Unix socket (`socket(): Operation not permitted`). No local visual/browser pass is claimed.

GitHub CI must be checked on the final branch commit; presence of a workflow file alone does not establish a pass. Real Magpie installation and native key capture in a logged-in Windows WeChat account require the user's machine and have not been claimed as verified. No real account data was used or uploaded.

The dedicated branch is a standalone package tree. Do not merge it into the full application's main branch.
