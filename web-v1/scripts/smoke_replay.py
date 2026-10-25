"""通过实际下载验证桌面入口的完整复盘导出，并验证刷新续局不丢记录。"""
import json
import os
import subprocess
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'dist/replay-evidence'
OUT.mkdir(parents=True, exist_ok=True)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT / 'dist')))
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = os.environ.get('CENTURY_TEST_URL', f'http://127.0.0.1:{server.server_port}/').rstrip('/') + '/'
fixtures = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', """
import {createGame,applyAction} from './dist/js/engine.js';
let g=createGame(['甲','乙'],71);
for(let i=0;i<60;i++) g=applyAction(g,{type:'rest'});
const finished=structuredClone(g);finished.phase='finished';finished.triggerPlayer=0;
const legacy=structuredClone(g);delete legacy.replay;
console.log(JSON.stringify({long:g,finished,legacy}));
"""], cwd=ROOT))
errors = []


def download(page, action, suffix):
    with page.expect_download() as result:
        page.locator(f'[data-action="{action}"]').last.click()
    item = result.value
    assert item.suggested_filename.endswith(suffix), item.suggested_filename
    return Path(item.path()).read_text()


def check(page, fixture, url, shot):
    page.goto(url, wait_until='domcontentloaded')
    page.evaluate('(g)=>{localStorage.clear();localStorage.setItem("crystal-corridor-game-v2-canonical",JSON.stringify(g))}', fixture)
    page.reload(wait_until='domcontentloaded')
    if fixture['phase'] != 'finished':
        page.locator('[data-action="toggle-log"]').click()
    md = download(page, 'export-replay-md', '.md')
    data = json.loads(download(page, 'export-replay-json', '.json'))
    assert data['format'] == 'century-replay'
    assert data['current']['turnNumber'] == fixture['turnNumber']
    if 'replay' in fixture:
        assert len(data['replay']['turns']) == 60
        assert '第 60 手' in md and '个人第 30 回合' in md
    else:
        assert data['replay'] is None and '没有完整回合记录' in md
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.screenshot(path=str(OUT / shot))


try:
    with sync_playwright() as pw:
        for engine in ('chromium', 'webkit'):
            browser = getattr(pw, engine).launch(headless=True)
            context = browser.new_context(viewport={'width':1440,'height':900}, accept_downloads=True)
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            url = BASE + 'standalone.html'
            # 正式 Pages 的桌面首页也要验收。
            if os.environ.get('CENTURY_TEST_URL'):
                url = BASE
            for name, fixture in fixtures.items():
                check(page, fixture, url, f'{engine}-{name}.png')
            # 刷新后行动会继续追加，导出按钮不会消耗回合。
            page.goto(url, wait_until='domcontentloaded')
            page.locator('.duel-player[data-player="0"] [data-action="rest"]').click()
            saved = json.loads(page.evaluate('()=>localStorage.getItem("crystal-corridor-game-v2-canonical")'))
            assert saved['replay']['fromStart'] is False
            assert saved['replay']['initial']['turnNumber'] == 61
            assert len(saved['replay']['turns']) == 1
            context.close()
            browser.close()
    assert not errors, errors
    print('复盘导出通过：Chromium / WebKit，完整历史 / 旧存档 / 结算 / 刷新续局。')
finally:
    server.shutdown()
