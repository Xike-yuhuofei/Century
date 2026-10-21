"""Focus + AI V2 集成回归：开局、四类行动、支付与存档。"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_test_support import launch_browser

HTML = (Path(__file__).resolve().parent.parent / 'dist/standalone.html').as_uri()
KEY = 'crystal-corridor-game-v2-canonical'
with sync_playwright() as pw:
    browser = launch_browser(pw)
    page = browser.new_page(viewport={'width': 3440, 'height': 1440})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(HTML)
    # 默认开局为 1 真人 + 4 AI：多真人用例先显式展开第二个姓名输入框。
    page.select_option('#humanCount', '2')
    page.locator('#nameInputs input').nth(1).fill('右侧真人')
    page.select_option('#humanCount', '1')
    page.select_option('#humanCount', '2')
    assert page.locator('#nameInputs input').nth(1).input_value() == '右侧真人'
    page.select_option('#humanCount', '1')
    page.select_option('#botCount', '0')
    assert page.locator('[data-action="start"]').is_disabled()
    page.select_option('#humanCount', '2')
    page.click('[data-action="start"]')

    def state():
        return page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)

    def load(game):
        page.evaluate('([key,g]) => localStorage.setItem(key,JSON.stringify(g))', [KEY, game])
        page.reload()

    player = '.duel-player[data-player="0"] '
    page.locator(player + '.card-create[data-action="play-hand"]').click()
    assert state()['players'][0]['played'] == ['S01']
    page.locator('.duel-player[data-player="1"] [data-action="rest"]').click()
    page.locator(player + '.card-upgrade[data-action="play-hand"]').click()
    page.click('[data-action="upgrade-step"][data-color="0"]')
    page.click('[data-action="confirm-upgrade"]')
    assert state()['players'][0]['stock'] == [4, 1, 0, 0]
    page.locator('.duel-player[data-player="1"] [data-action="rest"]').click()
    game = state()
    target = game['merchantMarket'][1]['id']
    page.click('.duel-center [data-action="get-merchant"][data-index="1"]')
    page.click('[data-action="payment-pick"][data-color="0"]')
    page.click('[data-action="confirm-acquire"]')
    assert target in state()['players'][0]['hand']
    assert state()['merchantMarket'][0]['bonus'] == [1, 0, 0, 0]
    page.locator('.duel-player[data-player="1"] [data-action="rest"]').click()
    page.locator(player + '[data-action="rest"]').click()
    assert state()['players'][0]['played'] == []
    page.locator('.duel-player[data-player="1"] [data-action="rest"]').click()
    # Supply a public target's exact cost, then execute the real claim UI.
    game = state()
    card_id = game['golemMarket'][0]
    import json
    cards = json.loads((Path(__file__).resolve().parents[2] / 'data/cards.json').read_text())
    cost = next(c['need'] for c in cards['golems'] if c['id'] == card_id)
    game['players'][0]['stock'] = [cost.get(c, 0) for c in cards['color_order']]
    load(game)
    page.click('.duel-center [data-action="claim"][data-index="0"]')
    assert card_id in state()['players'][0]['claimed']
    assert state()['version'] == 2
    assert not errors, errors
    for bots in range(1, 5):
        page.evaluate('(key) => localStorage.removeItem(key)', KEY)
        page.reload()
        page.select_option('#humanCount', '1')
        page.select_option('#botCount', str(bots))
        page.click('[data-action="start"]')
        assert len(state()['players']) == bots + 1
        assert page.locator('.handoff-card').count() == 0
        page.locator('.duel-player .card-create[data-action="play-hand"]').click()
        page.wait_for_function("key => { const g=JSON.parse(localStorage.getItem(key)); return g.current===0 && g.players.slice(1).every(p=>p.turns>=1); }", arg=KEY, timeout=30000)
        assert page.locator('.handoff-card').count() == 0
    assert not errors, errors
    browser.close()
print('Focus 真实行动与开局校验通过')
