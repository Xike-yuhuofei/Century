"""LLM 玩家 UI 冒烟（CI 确定性 Mock 代理；不依赖 Codex/ChatGPT 登录）。

验证：
- 设置页 LLM 席位与本地代理配置可见、移动端无横向溢出；
- 1 真人 + 1 LLM 席位的完整一轮：思考状态 → 决策面板（理由/目标/替代/风险）→ 导出；
- 未配置/不可达代理时自动回退离线冠军，游戏仍可继续；
- 页面无 console/pageerror；导出 JSON 不含任何密钥字段。
"""
import json
import re
import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

from browser_test_support import launch_browser

ROOT = Path(__file__).resolve().parent.parent


class StaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.split('?')[0] == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()


class MockLLMHandler(BaseHTTPRequestHandler):
    delay = 0.7

    def log_message(self, *args):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        body = json.dumps({'object': 'list', 'data': [{'id': 'mock-ui-proxy', 'object': 'model'}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length).decode('utf-8')
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self.send_response(400)
            self._cors()
            self.end_headers()
            return
        texts = [m.get('content', '') for m in payload.get('messages', []) if m.get('role') == 'user']
        prompt = texts[-1] if texts else ''
        ids = re.findall(r'^- (a[0-9a-z-]+) \[', prompt, re.MULTILINE)
        chosen = ids[0] if ids else 'missing'
        alternatives = [{'actionId': x, 'comparison': 'Mock 替代项'} for x in ids[1:3]]
        content = json.dumps({
            'selectedActionId': chosen,
            'reason': 'Mock UI 冒烟：选择首个公开合法候选。',
            'primaryGoal': '验证 LLM 决策面板与数据导出。',
            'alternativeActions': alternatives,
            'expectedBenefits': ['结构合法', '可复现'],
            'risks': ['Mock 不代表真实模型能力'],
            'strategyTags': ['engine', 'risk'],
        }, ensure_ascii=False)
        import time
        time.sleep(self.delay)
        body = json.dumps({
            'id': 'mock-chat-1',
            'object': 'chat.completion',
            'model': 'mock-ui-proxy',
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 100, 'completion_tokens': 50, 'total_tokens': 150},
        }, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)


def serve(handler):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def configure(page, endpoint):
    page.add_init_script(
        "localStorage.removeItem('crystal-corridor-game-v2-canonical');"
        "localStorage.setItem('century-llm-config-v1', JSON.stringify({"
        f"endpoint: {json.dumps(endpoint)}, model: 'mock-ui-proxy', timeoutMs: 10000, "
        "maxTokens: 400, maxCalls: 50, tokenBudget: 200000}))"
    )


def start_llm_game(page):
    page.select_option('#humanCount', '1')
    page.select_option('#botCount', '1')
    page.select_option('#llmSeats', '1')
    page.click('[data-action="start"]')
    page.wait_for_selector('.duel-player[data-player="1"]')
    page.locator('[data-action="play-hand"]').first.click()
    page.wait_for_timeout(200)


def main():
    static_server = serve(partial(StaticHandler, directory=str(ROOT / 'dist')))
    mock_server = serve(MockLLMHandler)
    base = f'http://127.0.0.1:{static_server.server_port}/'
    mock_endpoint = f'http://127.0.0.1:{mock_server.server_port}/v1'
    errors = []
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.on('pageerror', lambda e: errors.append(f'pageerror:{e}'))
        page.on('console', lambda m: errors.append(f'console:{m.text}') if m.type == 'error' else None)
        configure(page, mock_endpoint)
        page.goto(base, wait_until='networkidle')
        page.wait_for_selector('#llmSeats')
        start_llm_game(page)
        page.wait_for_selector('.llm-chip-thinking', timeout=10000)
        page.wait_for_selector('.llm-decision-log', timeout=30000)
        stats = page.evaluate('() => window.__CENTURY_AI_RUNTIME_STATS__()')
        assert stats['llmSeats'] == [1], stats
        assert stats['llmDecisionCount'] == 1, stats
        assert stats['llmStats']['fallbacks'] == 0, stats
        page.locator('.llm-decision-log summary').first.click()
        text = page.locator('.llm-decision-log').inner_text()
        for needle in ('理由', '目标', '替代', '风险', 'mock-ui-proxy'):
            assert needle in text, f'决策面板缺少 {needle}: {text[:500]}'
        page.screenshot(path=str(ROOT / 'dist' / 'llm-ui-decision.png'), full_page=True)
        with page.expect_download(timeout=10000) as info:
            page.click('[data-action="export-llm"]')
        download = info.value
        exported = json.load(open(download.path()))
        assert exported['schema'] == 'century-llm-ui-game-v1'
        assert len(exported['decisions']) == 1
        serialized = json.dumps(exported, ensure_ascii=False)
        assert 'ZHIPU_API_KEY' not in serialized and 'apiKey' not in serialized
        assert not errors, errors
        page.close()

        # 不可达代理：LLM 席位必须回退离线冠军，游戏仍可继续且标记可见。
        fallback = browser.new_page(viewport={'width': 1280, 'height': 900})
        configure(fallback, 'http://127.0.0.1:9/v1')
        fallback.goto(base, wait_until='networkidle')
        start_llm_game(fallback)
        fallback.wait_for_selector('.llm-decision-log', timeout=30000)
        fallback.locator('.llm-decision-log summary').first.click()
        fb_text = fallback.locator('.llm-decision-log').inner_text()
        assert '回退' in fb_text, fb_text[:500]
        fb_stats = fallback.evaluate('() => window.__CENTURY_AI_RUNTIME_STATS__()')
        assert fb_stats['llmStats']['fallbacks'] >= 1, fb_stats
        fallback.screenshot(path=str(ROOT / 'dist' / 'llm-ui-fallback.png'), full_page=True)
        fallback.close()

        # 移动端设置页：LLM 配置可见且无横向溢出。
        mobile = browser.new_page(viewport={'width': 390, 'height': 844})
        mobile.add_init_script("localStorage.removeItem('crystal-corridor-game-v2-canonical')")
        mobile.goto(base, wait_until='networkidle')
        assert mobile.locator('.llm-setup').count() == 1
        overflow = mobile.evaluate('() => document.documentElement.scrollWidth > document.documentElement.clientWidth')
        assert not overflow, '移动端出现横向溢出'
        mobile.screenshot(path=str(ROOT / 'dist' / 'llm-ui-mobile-setup.png'), full_page=True)
        mobile.close()
        browser.close()
    static_server.shutdown()
    mock_server.shutdown()
    print(json.dumps({'stats': stats, 'fallback': fb_stats, 'exportedDecisions': len(exported['decisions'])}, ensure_ascii=False, indent=2))
    print('LLM UI smoke: PASS')


if __name__ == '__main__':
    main()
