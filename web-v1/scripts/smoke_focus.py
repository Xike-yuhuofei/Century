from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_test_support import launch_browser
ROOT=Path(__file__).resolve().parent.parent
html=(ROOT/'dist/standalone.html').read_text(encoding='utf-8')
with sync_playwright() as pw:
    browser=launch_browser(pw)
    errors=[]
    positions_0=None
    for bots in (0,1,2,3,4):
        page=browser.new_page(viewport={'width':3440,'height':1440}, device_scale_factor=1)
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(html)
        page.select_option('#botCount',str(bots))
        page.click('[data-action="start"]')
        assert page.locator('.focus-board .duel-player').count()==2
        assert page.locator('.ai-lane').count()==bots
        pos=page.locator('.duel-player').evaluate_all('(els)=>els.map(e=>({x:Math.round(e.getBoundingClientRect().x),w:Math.round(e.getBoundingClientRect().width)}))')
        if positions_0 is None: positions_0=pos
        assert pos==positions_0, '增加 AI 不可改变左右真人手牌区宽度与位置'
        metrics=page.evaluate('''()=>({docW:document.documentElement.scrollWidth,docH:document.documentElement.scrollHeight,clientW:innerWidth,clientH:innerHeight,canvas:document.querySelector('.duel-table').getBoundingClientRect().height,hand:document.querySelector('.player-hand-grid').getBoundingClientRect().height,ai:document.querySelector('.ai-monitor')?.getBoundingClientRect().height||0, golem:document.querySelector('.duel-center .golem-card').getBoundingClientRect().height,merchant:document.querySelector('.duel-center .merchant-card').getBoundingClientRect().height,gridRows:getComputedStyle(document.querySelector('.player-hand-grid')).gridAutoRows})''')
        print(bots, metrics, pos)
        assert metrics['docW']<=3440 and metrics['docH']<=1440,metrics
        assert metrics['hand']>650,metrics
        assert metrics['golem']<190 and metrics['merchant']<165
        assert page.locator('[data-action="toggle-log"]').count()==1
        assert page.locator('.duel-center .merchant-grid .card-foot').count()==6
        assert '免费' in page.locator('.duel-center .merchant-grid .card-foot').first.inner_text()
        assert '费用 5 颗' in page.locator('.duel-center .merchant-grid .card-foot').last.inner_text()
        page.locator('[data-action="toggle-log"]').click()
        assert page.locator('.focus-log-popover').count()==1
        page.locator('[data-action="toggle-log"]').first.click()
        assert page.locator('.focus-log-popover').count()==0
        if bots:
            page.locator('.ai-lane-label').first.click()
            assert page.locator('.ai-inspector').count()==1
            assert page.locator('.ai-inspector .merchant-card').count()>=2
            page.locator('.ai-inspector [data-action="inspect-ai"]').click()
            assert page.locator('.ai-inspector').count()==0
        page.screenshot(path=str(ROOT/f'dist/focus-{bots}ai-3440x1440.png'), full_page=True)
        if bots==4:
            # two human turns then four AI responses
            page.locator('.duel-player[data-player="0"] .card-create[data-action="play-hand"]').first.click()
            page.locator('.duel-player[data-player="1"] .card-create[data-action="play-hand"]').first.click()
            page.wait_for_function("() => document.querySelector('.duel-player[data-player=\"0\"].duel-active')", timeout=30000)
            assert page.locator('.duel-player[data-player="0"].duel-active').count()==1
            assert page.locator('.duel-player[data-player="0"] .played-face').count()==1
            page.screenshot(path=str(ROOT/'dist/focus-after-round.png'))
        page.close()
    phone=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
    phone.on('pageerror',lambda e:errors.append(str(e)))
    phone.set_content(html)
    phone.select_option('#botCount','4')
    phone.click('[data-action="start"]')
    assert phone.evaluate('document.documentElement.scrollWidth<=innerWidth')
    phone.screenshot(path=str(ROOT/'dist/focus-mobile.png'),full_page=True)
    assert not errors,errors
    browser.close()
print('FOCUS 浏览器检查通过')
