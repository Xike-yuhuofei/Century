"""AI Worker 运行时真实浏览器冒烟（Chromium；夜间任务 C）。

验证 dist/ai-runtime/harness.html（opt-in 验收页）在真实浏览器的行为：
Worker 决策等价、正式引擎合法性、协议防火墙、500/1000ms 预算下的主线程
响应性（longtask=0、帧隙 < 250ms）。不跑对局、不占满 CPU。
"""
import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT / 'dist')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base + 'ai-runtime/harness.html')
        page.wait_for_function('() => window.__AI_RUNTIME_HARNESS__ !== undefined', timeout=60000)
        report = page.evaluate('() => window.__AI_RUNTIME_HARNESS__')
        browser.close()
    server.shutdown()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if errors:
        raise SystemExit(f'页面错误：{errors}')
    if not report.get('pass'):
        failed = [c for c in report.get('checks', []) if not c.get('pass')]
        raise SystemExit(f'验收未通过：{failed}')
    print('AI runtime harness: PASS')


if __name__ == '__main__':
    main()
