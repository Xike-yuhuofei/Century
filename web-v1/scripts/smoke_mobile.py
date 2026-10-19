"""手机触屏回归：布局、三分区、商人获取、手牌、真人切换、响应式切换。"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_test_support import launch_browser

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / 'dist/mobile/index.html').as_uri()
HTML_DESKTOP = (ROOT / 'dist/standalone.html').as_uri()
KEY = 'crystal-corridor-game-v2-canonical'

with sync_playwright() as pw:
    browser = launch_browser(pw)
    errors = []
    # 独立手机版在大屏浏览器中也必须显示手机 UI，不能退回桌面版。
    desktop_preview = browser.new_page(viewport={'width': 1440, 'height': 900})
    desktop_preview.on('pageerror', lambda error: errors.append(str(error)))
    desktop_preview.goto(HTML)
    assert desktop_preview.locator('html[data-century-mode="mobile"]').count() == 1
    desktop_preview.locator('[data-action="start"]').click()
    assert desktop_preview.locator('.mobile-board').count() == 1
    assert desktop_preview.locator('.duel-table').count() == 0
    assert desktop_preview.locator('.mobile-board').evaluate('(el) => el.getBoundingClientRect().width') <= 641
    assert desktop_preview.locator('.mobile-more .page-version-link').get_attribute('href') == '../'
    desktop_preview.close()

    # 原根目录入口仍保持桌面 UI，双入口复用同一规则引擎。
    desktop = browser.new_page(viewport={'width': 1440, 'height': 900})
    desktop.on('pageerror', lambda error: errors.append(str(error)))
    desktop.goto(HTML_DESKTOP)
    desktop.locator('[data-action="start"]').click()
    assert desktop.locator('.mobile-board').count() == 0
    assert desktop.locator('.duel-table').count() == 1
    desktop.close()

    for width, height in [(320, 640), (390, 844), (430, 932)]:
        page = browser.new_page(
            viewport={'width': width, 'height': height},
            device_scale_factor=2, is_mobile=True, has_touch=True
        )
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(HTML)
        page.select_option('#humanCount', '1')
        page.select_option('#botCount', '1')
        page.locator('[data-action="start"]').tap()
        assert page.locator('.mobile-board').count() == 1
        assert page.locator('.duel-table').count() == 0
        metrics = page.evaluate("""() => {
          const board=document.querySelector('.mobile-board');
          const stage=document.querySelector('.mobile-stage').getBoundingClientRect();
          const dock=document.querySelector('.mobile-dock').getBoundingClientRect();
          return {vw:innerWidth, docW:document.documentElement.scrollWidth,
             viewportH:innerHeight, boardH:board.getBoundingClientRect().height,
             stageH:stage.height, dockH:dock.height,
             stageBottom:stage.bottom, dockTop:dock.top, dockBottom:dock.bottom};
        }""")
        print(width, metrics)
        assert metrics['docW'] <= width, metrics
        assert metrics['stageH'] >= 120, metrics
        assert abs(metrics['dockTop'] - metrics['stageBottom']) < 2, metrics
        assert metrics['dockBottom'] <= metrics['viewportH'] + 2, metrics
        assert page.locator('.mobile-dock-cards [data-action="play-hand"]').count() == 2
        page.locator('[data-action="mobile-tab"][data-tab="merchants"]').tap()
        assert page.locator('.mobile-merchants .merchant-card').count() == 6
        assert '免费' in page.locator('.mobile-merchants .card-foot').first.inner_text()
        assert '费用 5 颗' in page.locator('.mobile-merchants .card-foot').last.inner_text()
        page.locator('[data-action="mobile-tab"][data-tab="opponents"]').tap()
        assert page.locator('.mobile-rival').count() == 1
        page.locator('.mobile-rival summary').tap()
        assert page.locator('.mobile-rival[open] .merchant-card').count() >= 2
        page.locator('[data-action="mobile-tab"][data-tab="golems"]').tap()
        assert page.locator('.mobile-golems .golem-card').count() == 5
        page.locator('[data-action="mobile-expand-hand"]').tap()
        assert page.locator('.mobile-hand-expanded').count() == 1
        page.locator('[data-action="mobile-expand-hand"]').tap()
        assert page.locator('.mobile-hand-expanded').count() == 0
        page.locator('.mobile-dock-cards .card-create[data-action="play-hand"]').first.tap()
        page.wait_for_function("(key) => JSON.parse(localStorage.getItem(key)).players[0].played.includes('S01')", arg=KEY, timeout=30000)
        page.wait_for_function("(key) => JSON.parse(localStorage.getItem(key)).current === 0", arg=KEY, timeout=30000)
        assert page.locator('.mobile-played-label').inner_text().startswith('已打出 1')
        page.locator('[data-action="mobile-toggle-played"]').tap()
        assert page.locator('.mobile-played-cards .played-face').count() == 1
        page.locator('[data-action="mobile-toggle-played"]').tap()
        page.locator('[data-action="mobile-tab"][data-tab="merchants"]').tap()
        target_id = page.evaluate("(key) => JSON.parse(localStorage.getItem(key)).merchantMarket[1].id", KEY)
        page.locator('.mobile-merchants [data-action="get-merchant"][data-index="1"]').tap()
        assert page.locator('[data-action="payment-pick"]').count() == 4
        page.locator('[data-action="payment-pick"][data-color="0"]').tap()
        page.locator('[data-action="confirm-acquire"]').tap()
        page.wait_for_function("([key,id]) => JSON.parse(localStorage.getItem(key)).players[0].hand.includes(id)", arg=[KEY,target_id])
        page.screenshot(path=str(ROOT / f'dist/mobile-{width}.png'), full_page=True)
        page.close()

    landscape = browser.new_page(viewport={'width': 932, 'height': 430}, is_mobile=True, has_touch=True)
    landscape.on('pageerror', lambda error: errors.append(str(error)))
    landscape.goto(HTML)
    landscape.select_option('#humanCount', '1')
    landscape.select_option('#botCount', '1')
    landscape.locator('[data-action="start"]').tap()
    assert landscape.locator('.mobile-board').count() == 1
    assert landscape.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert landscape.locator('.mobile-stage').evaluate('(el) => el.getBoundingClientRect().height') >= 120
    landscape.screenshot(path=str(ROOT / 'dist/mobile-landscape-932.png'), full_page=True)
    landscape.close()

    page = browser.new_page(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(HTML)
    page.select_option('#humanCount','2')
    page.select_option('#botCount','3')
    page.locator('[data-action="start"]').tap()
    assert page.locator('.mobile-board').count() == 1
    assert '玩家 1' in page.locator('.mobile-player-line').inner_text()
    page.locator('.mobile-dock-cards .card-create[data-action="play-hand"]').first.tap()
    assert '玩家 2' in page.locator('.mobile-player-line').inner_text()
    assert page.locator('.mobile-dock-cards .card-create[data-action="play-hand"]').count() == 1
    page.locator('[data-action="mobile-tab"][data-tab="opponents"]').tap()
    assert page.locator('.mobile-rival').count() == 4
    page.set_viewport_size({'width': 1024,'height': 768})
    assert page.locator('.mobile-board').count() == 0
    assert page.locator('.duel-table').count() == 1
    page.set_viewport_size({'width':390,'height':844})
    assert page.locator('.mobile-board').count() == 1
    assert '玩家 2' in page.locator('.mobile-player-line').inner_text()
    page.locator('.mobile-more summary').tap()
    page.locator('[data-action="help"]').tap()
    assert page.locator('.help-dialog').count() == 1
    page.locator('[data-action="close-help"]').last.tap()
    assert page.locator('.help-dialog').count() == 0
    assert not errors, errors
    browser.close()
print('独立手机版 /mobile/ 与电脑版入口、320 / 390 / 430 / 横屏 932、多人回归通过')
