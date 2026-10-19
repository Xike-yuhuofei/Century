from pathlib import Path
from playwright.sync_api import sync_playwright
import json
ROOT=Path(__file__).resolve().parent.parent
html=(ROOT/'dist/standalone.html').read_text(encoding='utf-8')
def create(browser,width=3440,height=1440):
    p=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
    p.set_content(html)
    return p
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    errors=[]
    baseline=create(browser)
    baseline.on('pageerror',lambda e:errors.append(str(e)))
    baseline.select_option('#botCount','0')
    baseline.click('[data-action="start"]')
    assert baseline.locator('.duel-player').count()==2
    baseline_positions=baseline.locator('.duel-player').evaluate_all('(els)=>els.map(e=>({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))')
    for bots in (1,2,3,4):
        p=create(browser)
        p.on('pageerror',lambda e:errors.append(str(e)))
        assert p.locator('#humanCount').input_value()=='2'
        p.select_option('#botCount',str(bots))
        assert p.locator('.ai-slot.selected').count()==bots
        assert p.locator('[data-action="start"]').is_enabled()
        p.click('[data-action="start"]')
        assert p.locator('.duel-player').count()==2
        assert p.locator('.ai-seat').count()==bots
        assert p.locator('.duel-player[data-player="0"] .hand-tile').count()==2
        assert p.locator('.duel-player[data-player="1"] .hand-tile').count()==2
        assert p.locator('.human-ai-center .golem-card').count()==5
        assert p.locator('.human-ai-center .duel-market .merchant-card').count()==6
        positions=p.locator('.duel-player').evaluate_all('(els)=>els.map(e=>({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))')
        assert positions==baseline_positions,(bots,positions,baseline_positions)
        metrics=p.evaluate('''() => ({scrollW:document.documentElement.scrollWidth,w:innerWidth,scrollH:document.documentElement.scrollHeight,h:innerHeight,header:document.querySelector('.topbar').getBoundingClientRect().height,ai:document.querySelector('.human-ai-opponents').getBoundingClientRect().height,center:document.querySelector('.human-ai-center').getBoundingClientRect().height})''')
        print('3440 bots',bots,metrics)
        assert metrics['scrollW']<=metrics['w']
        assert metrics['scrollH']<=metrics['h'],f'bots={bots}, {metrics}'
        assert p.locator('.handoff-card').count()==0
        p.screenshot(path=str(ROOT/f'dist/duo-{bots}ai-3440x1440.png'),full_page=True)
        # 人类 1 正常出牌 -> 人类 2 可以直接操作，无交接层
        p.locator('.duel-player[data-player="0"] .card-create[data-action="play-hand"]').click()
        assert p.locator('.duel-player[data-player="1"].duel-active').count()==1
        assert p.locator('.duel-player[data-player="0"] .played-face').count()==1
        assert p.locator('.handoff-card').count()==0
        p.locator('.duel-player[data-player="1"] .card-create[data-action="play-hand"]').click()
        p.wait_for_timeout(480*bots+750)
        assert p.locator('.duel-player[data-player="0"].duel-active').count()==1
        assert p.locator('.handoff-card').count()==0
        # AI 卡牌回收区折叠保持左右真人坐标
        assert p.locator('.human-ai-seat-grid .zone-folded').count()==bots
        p.locator('.ai-seat [data-action="toggle-played"]').first.click()
        assert p.locator('.human-ai-seat-grid .zone-folded').count()==bots-1
        assert p.locator('.ai-seat .played-face').count()>=1
        after=p.locator('.duel-player').evaluate_all('(els)=>els.map(e=>({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))')
        assert positions==after
        p.close()
    phone=create(browser,390,844)
    phone.select_option('#botCount','4')
    phone.click('[data-action="start"]')
    assert phone.locator('.duel-player').count()==2 and phone.locator('.ai-seat').count()==4
    assert phone.evaluate('document.documentElement.scrollWidth<=innerWidth')
    phone.screenshot(path=str(ROOT/'dist/duo-4ai-mobile.png'),full_page=True)
    # 老模式 1 真人+4AI 仍然保留
    solo=create(browser)
    solo.select_option('#humanCount','1')
    solo.select_option('#botCount','4')
    solo.click('[data-action="start"]')
    assert solo.locator('.duel-player').count()==1 and solo.locator('.ai-seat').count()==4
    # 3 真人+ 0 AI 仍为交接版
    three=create(browser)
    three.select_option('#humanCount','3')
    three.select_option('#botCount','0')
    three.click('[data-action="start"]')
    assert three.locator('.players-strip .player-pill').count()==3
    three.locator('.hand-grid .card-create').click()
    assert three.locator('.handoff-card').count()==1
    # 4 真人+3AI超过 6 禁止
    bad=create(browser)
    bad.select_option('#humanCount','4')
    bad.select_option('#botCount','3')
    assert bad.locator('[data-action="start"]').is_disabled()
    assert not errors,errors
    browser.close()
print('浏览器回归完成')
