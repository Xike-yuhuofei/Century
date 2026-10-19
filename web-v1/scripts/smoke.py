"""桌面/移动端冒烟测试：pip install playwright && playwright install chromium。
在受限容器中使用 set_content，生产环境可直接用浏览器打开 dist/standalone.html。
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parent.parent
HTML = (BASE / 'dist/standalone.html').read_text(encoding='utf-8')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    wide = browser.new_page(viewport={'width': 3440, 'height': 1440}, device_scale_factor=1)
    errors = []
    wide.on('pageerror', lambda e: errors.append(str(e)))
    wide.set_content(HTML)
    wide.locator('[data-action="start"]').click()
    assert wide.locator('.duel-player').count() == 2
    assert wide.locator('.duel-center .golem-card').count() == 5
    assert wide.locator('.duel-center .merchant-card').count() == 6
    assert wide.locator('.duel-player .duel-hand .merchant-card').count() == 4
    assert wide.locator('.handoff-card').count() == 0
    assert wide.locator('.duel-active [data-action="play-hand"]').count() == 2
    assert wide.locator('.duel-waiting [data-action="play-hand"]').count() == 0
    assert wide.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert wide.evaluate('document.documentElement.scrollHeight <= innerHeight')
    # 卡面每颗水晶绘制一颗 gem，当前先手商队黄3颗。
    assert wide.locator('.duel-player').first.locator('.resource-bar .gem-yellow').count() == 3
    assert wide.locator('.duel-player').last.locator('.resource-bar .gem-yellow').count() == 4
    assert '×' not in wide.locator('.duel-center .merchant-card').first.inner_text()
    wide.screenshot(path=str(BASE/'dist/duel-3440x1440.png'), full_page=True)
    # 打出牌后，两位玩家仍在屏幕上，已打出卡牌正面显示作用和编号。
    wide.locator('.duel-active .duel-hand .card-create').click()
    assert wide.locator('.duel-player').count() == 2
    assert wide.locator('.handoff-card').count() == 0
    assert wide.locator('.duel-player .played-face').count() == 1
    assert wide.locator('.duel-player .played-face .card-head').count() == 1
    assert wide.locator('.duel-player .played-face .gem').count() == 2
    assert wide.locator('.duel-active .duel-name').inner_text() == '玩家 2'
    wide.screenshot(path=str(BASE/'dist/duel-after-play-3440x1440.png'), full_page=True)
    # 玩家2升级、玩家1休息，保持同屏并验证动作正常。
    wide.locator('.duel-active .duel-hand .card-upgrade').click()
    wide.locator('[data-action="upgrade-step"][data-color="0"]').click()
    wide.locator('[data-action="upgrade-step"][data-color="1"]').click()
    wide.locator('[data-action="confirm-upgrade"]').click()
    assert wide.locator('.duel-active .duel-name').inner_text() == '玩家 1'
    wide.locator('.duel-active [data-action="rest"]').click()
    assert wide.locator('.duel-player').first.locator('.duel-played .merchant-card').count() == 0
    assert wide.locator('.duel-player').first.locator('.duel-hand .merchant-card').count() == 2
    assert errors == [], errors
    print('UWQHD 双人同屏测试通过：两侧卡区、卡面水晶、已打出正面、升级及休息')

    # 3-5 人模式延续原有交接遮罩。
    classic = browser.new_page(viewport={'width':1440, 'height':1000})
    classic.set_content(HTML)
    classic.locator('#playerCount').select_option('3')
    classic.locator('[data-action="start"]').click()
    assert classic.locator('.duel-player').count() == 0
    classic.locator('.hand-grid .card-create').click()
    assert classic.locator('.handoff-card').count() == 1
    classic.locator('[data-action="ready"]').click()
    assert classic.locator('.handoff-card').count() == 0
    print('传统 3 人模式交接回归测试通过')

    phone = browser.new_page(viewport={'width':390,'height':844})
    phone.set_content(HTML)
    phone.locator('[data-action="start"]').click()
    assert phone.locator('.duel-player').count() == 2
    assert phone.locator('.duel-center .merchant-card').count() == 6
    assert phone.evaluate('document.documentElement.scrollWidth <= innerWidth')
    phone.screenshot(path=str(BASE/'dist/duel-mobile.png'), full_page=True)
    print('移动端双人响应式基本测试通过')
    browser.close()