"""验证复盘导出：手机端实际下载 JSON（在线/离线），桌面端手动导出已移除、仅自动导出。"""
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


def check(page, mobile, fixture, url, shot):
    key = 'century-mobile-game-v2' if mobile else 'crystal-corridor-game-v2-canonical'
    page.goto(url, wait_until='domcontentloaded')
    page.evaluate('([key,g])=>{localStorage.clear();localStorage.setItem(key,JSON.stringify(g))}', [key, fixture])
    page.reload(wait_until='domcontentloaded')
    if mobile:
        page.locator('[data-action="resume"]').click()
        if page.locator('[data-action="ready"]').count():
            page.locator('[data-action="ready"]').click()
        # 手机端唯一导出入口：菜单 → 行动记录 → 导出复盘 JSON。
        page.locator('[data-action="menu"]').click()
        page.locator('[data-action="log"]').click()
        data = json.loads(download(page, 'export-replay-json', '.json'))
        assert data['format'] == 'century-replay'
        assert data['current']['turnNumber'] == fixture['turnNumber']
        if 'replay' in fixture:
            assert len(data['replay']['turns']) == 60
        else:
            assert data['replay'] is None
    else:
        # 桌面端手动导出已移除，复盘文件仅由自动导出（JSON）产生。
        assert page.locator('[data-action="export-replay-md"]').count() == 0
        assert page.locator('[data-action="export-replay-json"]').count() == 0
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.screenshot(path=str(OUT / shot))


try:
    with sync_playwright() as pw:
        for engine in ('chromium', 'webkit'):
            browser = getattr(pw, engine).launch(headless=True)
            for mobile in (False, True):
                context = browser.new_context(viewport={'width':390 if mobile else 1440, 'height':844 if mobile else 900}, accept_downloads=True)
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                url = BASE + ('mobile/' if mobile else 'standalone.html')
                # 正式 Pages 的桌面首页也要验收。
                if os.environ.get('CENTURY_TEST_URL') and not mobile:
                    url = BASE
                for name, fixture in fixtures.items():
                    check(page, mobile, fixture, url, f'{engine}-{mobile}-{name}.png')
                if not mobile:
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
                if mobile:
                    page.locator('[data-action="resume"]').click()
                    page.locator('[data-action="ready"]').click()
                    page.locator('[data-action="rest"]').click()
                    page.locator('[data-action="confirm"]').click()
                else:
                    page.locator('.duel-player[data-player="0"] [data-action="rest"]').click()
                key = 'century-mobile-game-v2' if mobile else 'crystal-corridor-game-v2-canonical'
                saved = json.loads(page.evaluate('(key)=>localStorage.getItem(key)', key))
                assert saved['replay']['fromStart'] is False
                assert saved['replay']['initial']['turnNumber'] == 61
                assert len(saved['replay']['turns']) == 1
                context.close()
            # 离线入口仍支持手机端 JSON 导出。
            if not os.environ.get('CENTURY_TEST_URL'):
                context = browser.new_context(viewport={'width':390,'height':844}, accept_downloads=True)
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                check(page, True, fixtures['long'], (ROOT / 'dist/mobile/standalone.html').as_uri(), f'{engine}-offline.png')
                context.close()
            browser.close()
    assert not errors, errors
    print('复盘导出通过：手机端 JSON 下载（Chromium / WebKit，在线 / 离线），桌面端手动导出已移除、自动导出开关可用。')
finally:
    server.shutdown()
