import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import worker
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from wechat_decrypt_tool.wechat_decrypt import WeChatDatabaseDecryptor

KEY = bytes.fromhex('01' * 32)
SALT = bytes.fromhex('23' * 16)

def plain_database(path, text='你好，微信'):
    with sqlite3.connect(path) as db:
        db.execute('PRAGMA page_size=4096')
        db.execute('CREATE TABLE messages(content TEXT)')
        db.execute('INSERT INTO messages VALUES (?)', (text,))
    raw = bytearray(path.read_bytes())
    # Move the two small leaf-page cell areas to reserve SQLCipher's 80 trailer bytes.
    # No overflow pages: assertions keep this fixture generator honest.
    for offset in range(0, len(raw), 4096):
        header = offset + (100 if offset == 0 else 0)
        assert raw[header] == 13
        assert raw[header + 1:header + 3] == b'\0\0'
        cells = int.from_bytes(raw[header + 3:header + 5], 'big')
        top = int.from_bytes(raw[header + 5:header + 7], 'big')
        raw[offset + top - 80:offset + 4016] = raw[offset + top:offset + 4096]
        raw[offset + 4016:offset + 4096] = b'\0' * 80
        raw[header + 5:header + 7] = (top - 80).to_bytes(2, 'big')
        for i in range(cells):
            at = header + 8 + i * 2
            ptr = int.from_bytes(raw[at:at + 2], 'big')
            raw[at:at + 2] = (ptr - 80).to_bytes(2, 'big')
    raw[20] = 80
    path.write_bytes(raw)
    with sqlite3.connect(path) as db:
        assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        assert db.execute('SELECT content FROM messages').fetchone()[0] == text
    return bytes(raw)

def encrypt(raw, key=KEY, passphrase=False):
    enc = hashlib.pbkdf2_hmac('sha512', key, SALT, 256000, 32) if passphrase else key
    mac = hashlib.pbkdf2_hmac('sha512', enc, bytes(x ^ 0x3a for x in SALT), 2, 32)
    out = b''
    for offset in range(0, len(raw), 4096):
        n = offset // 4096 + 1
        iv = bytes([n]) * 16
        body = raw[offset + (16 if n == 1 else 0):offset + 4016]
        cipher = Cipher(algorithms.AES(enc), modes.CBC(iv)).encryptor()
        payload = (SALT if n == 1 else b'') + cipher.update(body) + cipher.finalize() + iv
        checksum = hmac.new(mac, payload[16 if n == 1 else 0:] + n.to_bytes(4, 'little'), 'sha512').digest()
        out += payload + checksum
    return out

def checksum(data, state=(0, 0)):
    a, b = state
    for x, y in struct.iter_unpack('<II', data):
        a = (a + x + b) & 0xffffffff
        b = (b + y + a) & 0xffffffff
    return a, b

def wal(raw):
    salt = b'12345678'
    head = struct.pack('>IIII', 0x377f0682, 3007000, 4096, 0) + salt
    state = checksum(head)
    output = head + struct.pack('>II', *state)
    count = len(raw) // 4096
    for i in range(count):
        prefix = struct.pack('>II', i + 1, count if i == count - 1 else 0)
        page = raw[i * 4096:(i + 1) * 4096]
        state = checksum(page, checksum(prefix, state))
        output += prefix + salt + struct.pack('>II', *state) + page
    return output

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / '数据' / 'db_storage'
        self.source.mkdir(parents=True)
        self.output = self.root / 'output'
        self.raw = plain_database(self.root / 'fixture.db')
        (self.source / 'message.db').write_bytes(encrypt(self.raw))
        worker.CANCEL.clear()

    def request(self, **changes):
        return {'action': 'decrypt', 'source': str(self.source), 'output': str(self.output), 'key': KEY.hex(), **changes}

    def run_job(self, **changes):
        events = []
        with patch.object(worker, 'emit', side_effect=lambda kind, **data: events.append({'type': kind, **data})):
            worker.decrypt(self.request(**changes))
        return events

    def test_real_raw_key_and_passphrase_databases_readable(self):
        for mode in (False, True):
            with self.subTest(passphrase=mode):
                original = encrypt(self.raw, passphrase=mode)
                (self.source / 'message.db').write_bytes(original)
                event = self.run_job()[-1]
                self.assertEqual(event['state'], 'completed')
                with sqlite3.connect(Path(event['output']) / 'message.db') as db:
                    self.assertEqual(db.execute('SELECT content FROM messages').fetchone()[0], '你好，微信')
                self.assertEqual((self.source / 'message.db').read_bytes(), original)
                self.assertNotIn(KEY.hex(), (Path(event['output']) / 'report.json').read_text())

    def test_wrong_key_and_nonfirst_page_hmac_rejected(self):
        self.assertEqual(self.run_job(key='ab' * 32)[-1]['state'], 'error')
        damaged = bytearray(encrypt(self.raw)); damaged[-1] ^= 1
        (self.source / 'message.db').write_bytes(damaged)
        event = self.run_job()[-1]
        self.assertEqual(event['failed'], 1)
        self.assertFalse((Path(event['output']) / 'message.db').exists())

    def test_encrypted_committed_wal_restores_latest_message(self):
        updated = plain_database(self.root / 'updated.db', '最新消息')
        raw_wal = wal(encrypt(updated))
        (self.source / 'message.db-wal').write_bytes(raw_wal + b'uncommitted-tail')
        event = self.run_job()[-1]
        self.assertEqual(event['state'], 'completed')
        with sqlite3.connect(Path(event['output']) / 'message.db') as db:
            self.assertEqual(db.execute('SELECT content FROM messages').fetchone()[0], '最新消息')
        self.assertEqual((self.source / 'message.db-wal').read_bytes(), raw_wal + b'uncommitted-tail')

    def test_bad_wal_checksum_no_plaintext_published(self):
        value = bytearray(wal(encrypt(self.raw))); value[-10] ^= 1
        (self.source / 'message.db-wal').write_bytes(value)
        event = self.run_job()[-1]
        self.assertEqual(event['state'], 'error')
        self.assertFalse((Path(event['output']) / 'message.db').exists())

    def test_output_overlap_and_symlink_escape(self):
        for output in (str(self.source), str(self.source / 'out'), str(self.root)):
            with self.assertRaises(ValueError):
                self.run_job(output=output)
        if os.name != 'nt':
            (self.source / 'escape.db').symlink_to(self.root / 'fixture.db')
            self.assertEqual(len(worker.source_files(self.source)), 1)

    def test_cancel_before_publication_cleans_staging(self):
        original = WeChatDatabaseDecryptor.decrypt_database
        def interrupted(engine, source, output):
            result = original(engine, source, output)
            worker.CANCEL.set()
            return result
        with patch.object(WeChatDatabaseDecryptor, 'decrypt_database', interrupted):
            event = self.run_job()[-1]
        self.assertEqual(event['state'], 'canceled')
        self.assertEqual(list(Path(event['output']).glob('*.db')), [])
        self.assertEqual(list(Path(event['output']).glob('.staging-*')), [])

    def test_protocol_utf8_real_subprocess(self):
        process = subprocess.Popen([sys.executable, str(Path(worker.__file__))], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        process.stdin.write(json.dumps(self.request()) + '\n'); process.stdin.flush()
        events = []
        while True:
            event = json.loads(process.stdout.readline())
            events.append(event)
            if event['type'] == 'complete':
                break
        process.stdin.close()
        process.wait(timeout=5)
        process.stdout.close(); process.stderr.close()
        self.assertEqual(events[-1]['state'], 'completed')
        self.assertNotIn(KEY.hex(), json.dumps(events))


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.exe = self.root / 'Weixin.exe'; self.exe.touch()
        self.source = self.root / 'db_storage'; self.source.mkdir()
        raw = plain_database(self.root / 'plain.db')
        (self.source / 'message.db').write_bytes(encrypt(raw))
        worker.CANCEL.clear()

    def test_capture_validates_key_and_cleans_hook(self):
        import types
        from unittest.mock import MagicMock
        proc = MagicMock(); proc.pid=42; proc.info={'exe':str(self.exe),'cmdline':[str(self.exe)]}
        psutil = types.SimpleNamespace(process_iter=lambda _: [proc],wait_procs=lambda *a,**k:([],[]),Error=RuntimeError)
        wx = types.SimpleNamespace(initialize_hook=MagicMock(return_value=True),poll_key_data=lambda:{'key':KEY.hex()},cleanup_hook=MagicMock())
        events=[]
        with patch.dict(sys.modules,{'psutil':psutil,'wx_key':wx}), patch.object(sys,'platform','win32'), patch('subprocess.Popen',return_value=types.SimpleNamespace(pid=42)), patch.object(worker.time,'sleep'), patch.object(worker,'emit',side_effect=lambda kind,**data:events.append({'type':kind,**data})):
            worker.capture({'exe':str(self.exe),'source':str(self.source),'restart':True})
        wx.cleanup_hook.assert_called_once()
        proc.terminate.assert_called_once()
        self.assertEqual(events[-1]['state'],'completed')
        self.assertEqual(events[-2]['key'],KEY.hex())

    def test_capture_mismatched_key_still_cleans_hook(self):
        import types
        from unittest.mock import MagicMock
        psutil=types.SimpleNamespace(process_iter=lambda _: [],wait_procs=lambda *a,**k:([],[]),Error=RuntimeError)
        wx=types.SimpleNamespace(initialize_hook=lambda _:True,poll_key_data=lambda:{'key':'ab'*32},cleanup_hook=MagicMock())
        with patch.dict(sys.modules,{'psutil':psutil,'wx_key':wx}), patch.object(sys,'platform','win32'), patch('subprocess.Popen',return_value=types.SimpleNamespace(pid=42)), patch.object(worker.time,'sleep'), patch.object(worker,'emit'):
            with self.assertRaisesRegex(ValueError,'不匹配'):
                worker.capture({'exe':str(self.exe),'source':str(self.source),'restart':True})
        wx.cleanup_hook.assert_called_once()

    def test_restart_requires_explicit_form_consent(self):
        with patch.object(sys,'platform','win32'):
            with self.assertRaisesRegex(ValueError,'勾选'):
                worker.capture({'restart':False})

if __name__ == '__main__': unittest.main()
