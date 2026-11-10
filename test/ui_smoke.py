"""Run with pip install playwright; playwright install chromium. Synthetic data only."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1] / 'python'))
from test_worker import plain_database, encrypt, KEY
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp)
    source=root/'数据'; source.mkdir()
    raw=plain_database(root/'fixture.db')
    (source/'message.db').write_bytes(encrypt(raw))
    output=root/'输出'
    server=subprocess.Popen(['node',str(Path(__file__).with_name('ui-server.mjs'))],stdout=subprocess.PIPE,text=True,env={**os.environ,'MAGPIE_WECHAT_PYTHON':sys.executable})
    try:
        url=server.stdout.readline().strip()
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            page=browser.new_page(viewport={'width':1440,'height':1000})
            errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(url)
            ui=page.frame_locator('iframe')
            ui.locator('#source').fill(str(source))
            ui.locator('#output').fill(str(output))
            ui.locator('#key').fill(KEY.hex())
            ui.locator('#decrypt').click()
            ui.locator('#state').filter(has_text='已完成').wait_for(timeout=20000)
            assert ui.locator('#successful').inner_text()=='1'
            assert ui.locator('#failed').inner_text()=='0'
            result=Path(ui.locator('#output-result').input_value())
            with sqlite3.connect(result/'message.db') as db:
                assert db.execute('SELECT content FROM messages').fetchone()[0]=='你好，微信'
            artifacts=Path(os.environ.get('UI_ARTIFACTS',temp)); artifacts.mkdir(exist_ok=True,parents=True)
            page.screenshot(path=str(artifacts/'desktop.png'),full_page=True)
            ui.locator('#key').fill('bad-key'); ui.locator('#decrypt').click()
            ui.locator('#error').filter(has_text='64 位').wait_for()
            page.set_viewport_size({'width':420,'height':1000})
            page.screenshot(path=str(artifacts/'mobile.png'),full_page=True)
            width=ui.locator('body').evaluate('e=>({scroll:e.scrollWidth,width:e.clientWidth})')
            assert width['scroll']<=width['width']+1,width
            assert not errors,errors
            browser.close()
            print(json.dumps({'sandbox_gui':'passed','readable_sqlite':'passed','invalid_key_ui':'passed','browser_errors':errors}))
    finally:
        server.terminate(); server.wait(timeout=10); server.stdout.close()
