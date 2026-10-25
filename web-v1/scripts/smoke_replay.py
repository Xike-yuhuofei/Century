"""验证桌面端复盘导出：手动导出已移除，仅保留自动导出（JSON），并验证刷新续局不丢记录。"""
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


def check(page, fixture, url, shot):
    page.goto(url, wait_until='domcontentloaded')
    page.evaluate('(g)=>{localStorage.clear();localStorage.setItem("crystal-corridor-game-v2-canonical",JSON.stringify(g))}', fixture)
    page.reload(wait_until='domcontentloaded')
    # 桌面端手动导出已移除，复盘文件仅由自动导出（JSON）产生。
    assert page.locator('[data-action="export-replay-md"]').count() == 0
    assert page.locator('[data-action="export-replay-json"]').count() == 0
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
            # 桌面端仅剩的导出途径：历史面板中的自动导出（JSON）开关。
            page.locator('[data-action="history"]').click()
            assert page.locator('.auto-export-panel').count() == 1
            page.locator('[data-action="auto-export-enable"]').click()
            assert '自动导出：已开启' in page.locator('.auto-export-panel').inner_text()
            page.locator('[data-action="auto-export-disable"]').click()
            assert '自动导出：已关闭' in page.locator('.auto-export-panel').inner_text()
            page.locator('[data-action="close-history"]').last.click()
            # 刷新后行动会继续追加，行动不消耗回合。
            page.goto(url, wait_until='domcontentloaded')
            page.locator('.duel-player[data-player="0"] [data-action="rest"]').click()
            saved = json.loads(page.evaluate('()=>localStorage.getItem("crystal-corridor-game-v2-canonical")'))
            assert saved['replay']['fromStart'] is False
            assert saved['replay']['initial']['turnNumber'] == 61
            assert len(saved['replay']['turns']) == 1
            context.close()
            browser.close()
    assert not errors, errors
    print('复盘导出通过：Chromium / WebKit，桌面自动导出开关可用，刷新续局正常。')
finally:
    server.shutdown()
