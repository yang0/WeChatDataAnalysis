"""One job per process. JSON lines over stdio; never an HTTP server."""
from __future__ import annotations
import contextlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time

CANCEL = threading.Event()
PROTOCOL = sys.stdout

def emit(kind, **data):
    PROTOCOL.write(json.dumps({'type': kind, **data}, ensure_ascii=False) + '\n')
    PROTOCOL.flush()

def listen():
    for line in sys.stdin:
        try:
            if json.loads(line).get('cancel'):
                CANCEL.set()
        except (ValueError, AttributeError):
            pass
    CANCEL.set()  # Parent exited: never publish more plaintext.

def normalized_key(value):
    key = str(value or '').strip()
    if not re.fullmatch(r'[a-fA-F0-9]{64}', key):
        raise ValueError('密钥必须是 64 位十六进制字符串')
    return key

def source_files(source):
    if not source.is_dir():
        raise ValueError('请选择存在的微信数据目录（账号目录或 db_storage）')
    from wechat_decrypt_tool.database_filters import should_skip_source_database
    found = []
    # Do not follow links/junctions outside the selected data tree.
    for directory, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()
                   and not (getattr(Path(directory) / d, 'is_junction', lambda: False)())]
        for name in files:
            path = Path(directory) / name
            if (path.suffix.lower() == '.db' and not path.is_symlink()
                    and path.resolve().is_relative_to(source)
                    and not should_skip_source_database(name)):
                found.append(path)
    return sorted(found)

def decrypt(request):
    from wechat_decrypt_tool.wechat_decrypt import WeChatDatabaseDecryptor
    source = Path(request.get('source', '')).expanduser().resolve(strict=True)
    if not request.get('source') or not request.get('output'):
        raise ValueError('请选择数据目录与输出目录')
    output = Path(request['output']).expanduser().resolve()
    if output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError('输出目录与源目录不能相同或互相包含，请选择独立目录')
    key = normalized_key(request.get('key'))
    files = source_files(source)
    if not files:
        raise ValueError('目录内没有可解密的 .db 文件；当前仅支持微信 4.x 数据库')
    output.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix=time.strftime('wechat-%Y%m%d-%H%M%S-'), dir=output))
    emit('started', total=len(files), output=str(run))
    ok = failed = 0
    rows = []
    engine = WeChatDatabaseDecryptor(key)
    engine.cancel_check = CANCEL.is_set
    for index, source_db in enumerate(files):
        if CANCEL.is_set():
            break
        relative = source_db.relative_to(source)
        emit('progress', done=index, total=len(files), file=str(relative))
        # Core publishes only to staging; wrapper additionally rejects every HMAC warning.
        with tempfile.TemporaryDirectory(prefix='.staging-', dir=run) as temp:
            staged = Path(temp) / 'plain.db'
            unsafe_sidecar = any(Path(str(source_db) + suffix).is_symlink()
                                 for suffix in ('-wal', '-journal'))
            if unsafe_sidecar:
                success = False
                result = {'error': '拒绝读取指向其他位置的 WAL / journal 符号链接'}
            else:
                success = engine.decrypt_database(str(source_db), str(staged))
                result = engine.last_result
            if CANCEL.is_set():
                break
            success = bool(success and result.get('diagnostic_status') == 'ok'
                           and not result.get('failed_pages')
                           and not result.get('hmac_warning_pages'))
            message = ''
            if success:
                destination = run / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged, destination)
                ok += 1
            else:
                failed += 1
                message = str(result.get('error') or 'HMAC 或 SQLite 完整性校验失败')
                message = message.replace(key, '[密钥已隐藏]').replace(key.upper(), '[密钥已隐藏]')[:500]
            row = {'file': str(relative), 'success': success, 'error': message,
                   'wal_pages': int((result.get('wal') or {}).get('applied_pages', 0))}
            rows.append(row)
            emit('file', **row, done=index + 1, total=len(files), successful=ok, failed=failed)
    state = 'canceled' if CANCEL.is_set() else ('completed' if not failed else ('partial' if ok else 'error'))
    report = {'state': state, 'total': len(files), 'successful': ok, 'failed': failed,
              'output': str(run), 'files': rows}
    # Report contains paths/results only, never keys or decrypted message contents.
    (run / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    emit('complete', **{k: v for k, v in report.items() if k != 'files'})

def detect(request):
    candidates = []
    for folder in (Path.home() / 'Documents' / 'xwechat_files', Path.home() / 'xwechat_files',
                   Path.home() / 'Documents' / 'WeChat Files'):
        if folder.is_dir():
            accounts = sorted(p / 'db_storage' for p in folder.iterdir() if p.is_dir() and (p / 'db_storage').is_dir())
            candidates.extend(str(p) for p in accounts or [folder])
    exe = ''
    if sys.platform == 'win32':
        try:
            import psutil
            for proc in psutil.process_iter(['name', 'exe']):
                if str(proc.info.get('name') or '').lower() in ('weixin.exe', 'wechat.exe'):
                    exe = proc.info.get('exe') or ''
                    break
        except ImportError:
            pass
    emit('detected', candidates=candidates, exe=exe)
    emit('complete', state='completed')

def capture(request):
    if sys.platform != 'win32':
        raise ValueError('自动获取密钥目前仅支持 Windows；其他系统请填写已有密钥')
    if request.get('restart') is not True:
        raise ValueError('请先勾选同意重启微信，再获取密钥')
    import psutil
    import wx_key
    import subprocess
    exe_value = str(request.get('exe') or '').strip()
    if not exe_value:
        for proc in psutil.process_iter(['name', 'exe']):
            if str(proc.info.get('name') or '').lower() in ('weixin.exe', 'wechat.exe'):
                exe_value = proc.info.get('exe') or ''
                if exe_value:
                    break
    if not exe_value:
        raise ValueError('请先启动微信，或选择 Weixin.exe / WeChat.exe')
    exe = Path(exe_value).resolve(strict=True)
    if exe.name.lower() not in ('weixin.exe', 'wechat.exe') or not exe.is_file():
        raise ValueError('请选择微信的 Weixin.exe / WeChat.exe')
    targets = []
    for proc in psutil.process_iter(['name', 'exe']):
        try:
            if proc.info.get('exe') and Path(proc.info['exe']).resolve() == exe:
                targets.append(proc)
        except (OSError, psutil.Error):
            continue
    if CANCEL.is_set():
        return emit('complete', state='canceled')
    emit('progress', message='正在重启微信，请在微信窗口中完成登录…')
    for proc in targets:
        proc.terminate()
    _, alive = psutil.wait_procs(targets, timeout=8)
    if alive:
        raise ValueError('微信未完全退出，请手动退出后重试')
    if CANCEL.is_set():
        return emit('complete', state='canceled')
    launched = subprocess.Popen([str(exe)], cwd=str(exe.parent))
    time.sleep(2)
    pid = launched.pid
    candidates = []
    for proc in psutil.process_iter(['exe', 'cmdline']):
        try:
            if proc.info.get('exe') and Path(proc.info['exe']).resolve() == exe:
                candidates.append(proc)
        except (OSError, psutil.Error):
            pass
    if candidates:
        pid = min(candidates, key=lambda p: len(' '.join(p.info.get('cmdline') or []))).pid
    initialized = False
    try:
        if CANCEL.is_set():
            return emit('complete', state='canceled')
        initialized = bool(wx_key.initialize_hook(pid))
        if not initialized:
            raise ValueError('密钥组件初始化失败，请以管理员身份运行 Magpie，并确认微信版本受支持')
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if CANCEL.is_set():
                return emit('complete', state='canceled')
            data = wx_key.poll_key_data()
            if data and data.get('key'):
                # Validate against selected account before accepting the key, when supplied.
                key = normalized_key(data['key'])
                if request.get('source'):
                    from wechat_decrypt_tool.wechat_decrypt import _resolve_page1_key_material
                    root = Path(request['source']).resolve(strict=True)
                    verified = False
                    for db in source_files(root):
                        with db.open('rb') as stream:
                            page = stream.read(4096)
                        if len(page) == 4096 and _resolve_page1_key_material(bytes.fromhex(key), page):
                            verified = True
                            break
                    if not verified:
                        raise ValueError('获取的密钥与所选数据目录不匹配，请确认微信账号和目录一致')
                emit('key', key=key)
                return emit('complete', state='completed')
            time.sleep(.1)
        raise ValueError('获取密钥超时，请完成微信登录；若版本不兼容可填写已有密钥')
    finally:
        if initialized:
            wx_key.cleanup_hook()

def main():
    # Explicit UTF-8 is also required for Chinese paths on Windows.
    if hasattr(sys.stdin, 'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8')
        PROTOCOL.reconfigure(encoding='utf-8')
    request = json.loads(sys.stdin.readline())
    threading.Thread(target=listen, daemon=True).start()
    try:
        # Third-party components may print diagnostics; never let them enter JSON protocol.
        with contextlib.redirect_stdout(sys.stderr):
            {'decrypt': decrypt, 'capture': capture, 'detect': detect}[request['action']](request)
    except Exception as exc:
        message = str(exc)
        if request.get('key'):
            message = message.replace(request['key'], '[密钥已隐藏]').replace(request['key'].upper(), '[密钥已隐藏]')
        emit('failure', message=message[:500])
        emit('complete', state='canceled' if CANCEL.is_set() else 'error')

if __name__ == '__main__':
    main()
