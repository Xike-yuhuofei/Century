"""V1.3 浏览器交互回归：宽屏、大量手牌、排序、回收区、存档。"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_test_support import launch_browser
import json

BASE=Path(__file__).resolve().parent.parent
HTML=(BASE/'dist/standalone.html').read_text(encoding='utf-8')
def setup_page(page):
    page.evaluate('''() => {const store={};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem(k){return store[k]??null},setItem(k,v){store[k]=v},removeItem(k){delete store[k]}}});}''')
    page.set_content(HTML)
def reload_page(page):
    page.set_content(HTML)
with sync_playwright() as p:
    browser=launch_browser(p)
    errors=[]
    wide=browser.new_page(viewport={'width':3440,'height':1440},device_scale_factor=1)
    wide.on('pageerror',lambda e:errors.append(str(e)))
    setup_page(wide)
    wide.locator('[data-action="start"]').click()
    wide.evaluate('''() => {
      let g=JSON.parse(localStorage.getItem('crystal-corridor-game-v2-canonical'));
      g.players[0].hand.push(...g.merchantDeck.splice(0,14));
      localStorage.setItem('crystal-corridor-game-v2-canonical',JSON.stringify(g));
    }''')
    reload_page(wide)
    assert wide.locator('.duel-player[data-player="0"] .hand-tile').count()==16
    assert wide.locator('main').get_attribute('class').find('compact-cards')!=-1
    assert wide.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert wide.evaluate('document.documentElement.scrollHeight <= innerHeight')
    wide.screenshot(path=str(BASE/'dist/hand-16-3440x1440.png'),full_page=True)
    orig=wide.evaluate('JSON.parse(localStorage.getItem("crystal-corridor-game-v2-canonical"))')
    get_order=lambda:wide.locator('.duel-player[data-player="0"] .hand-tile').evaluate_all('(els)=>els.map(el=>el.dataset.cardId)')
    cards=get_order()
    wide.locator(f'[data-action="move-card"][data-id="{cards[2]}"][data-direction="-1"]').click()
    assert get_order()[:3]==[cards[0],cards[2],cards[1]],get_order()[:3]
    assert wide.evaluate('JSON.parse(localStorage.getItem("crystal-corridor-game-v2-canonical")).turnNumber')==orig['turnNumber']
    assert wide.evaluate('JSON.parse(localStorage.getItem("crystal-corridor-game-v2-canonical")).players[0].hand')==orig['players'][0]['hand']
    # Native drag-and-drop: card 5 moves before card 1.
    cards=get_order()
    wide.locator(f'.duel-player[data-player="0"] .hand-tile[data-card-id="{cards[4]}"]').drag_to(wide.locator(f'.duel-player[data-player="0"] .hand-tile[data-card-id="{cards[0]}"]'))
    assert get_order()[0]==cards[4],get_order()[:5]
    reload_page(wide)
    assert get_order()[0]==cards[4], '手动排序应跨刷新保留'
    wide.locator('[data-action="group-cards"][data-player="0"]').click()
    order=get_order()
    kinds=wide.locator('.duel-player[data-player="0"] .hand-tile').evaluate_all('els=>els.map(x=>x.querySelector(".merchant-card").className.match(/card-(create|upgrade|trade)/)[1])')
    assert kinds==sorted(kinds,key={'create':0,'upgrade':1,'trade':2}.get),kinds
    assert len(order)==16 and len(set(order))==16
    wide.locator('.duel-player[data-player="0"] [data-action="toggle-played"]').click()
    assert wide.locator('.duel-player[data-player="0"] .duel-played.zone-folded').count()==1
    assert wide.locator('.duel-player[data-player="0"] .duel-used-grid').count()==0
    wide.locator('.duel-player[data-player="0"] [data-action="toggle-played"]').click()
    assert wide.locator('.duel-player[data-player="0"] .duel-played.zone-folded').count()==0
    wide.locator('[data-action="card-size"]').click()
    assert 'normal-cards' in wide.locator('main').get_attribute('class')
    reload_page(wide)
    assert 'normal-cards' in wide.locator('main').get_attribute('class')
    wide.locator('.duel-player[data-player="0"] [data-action="play-hand"].card-create').first.click()
    assert wide.locator('.duel-player[data-player="0"] .played-face').count()==1
    wide.wait_for_timeout(850)
    assert wide.locator('.duel-player[data-player="0"] .hand-tile').count()==15
    assert not errors,errors
    print('3440×1440 大量手牌: compact/normal、拖动、移动按钮、分类、回收区、刷新保存、打出 通过')

    solo=browser.new_page(viewport={'width':3440,'height':1440})
    solo.on('pageerror',lambda e:errors.append(str(e)))
    setup_page(solo)
    solo.locator('#humanCount').select_option('1')
    solo.locator('#botCount').select_option('4')
    solo.locator('[data-action="start"]').click()
    assert solo.locator('.duel-player .hand-tile').count()==2
    assert solo.locator('.ai-lane [data-action="toggle-played"]').count()==4
    solo.locator('.ai-lane [data-action="toggle-played"]').first.click()
    assert solo.locator('.ai-lane-row-folded').count()==1
    assert solo.evaluate('document.documentElement.scrollHeight <= innerHeight')
    print('1 人 + 4 AI 公开引擎逐席位折叠，通过')

    multi=browser.new_page(viewport={'width':1440,'height':1000})
    multi.on('pageerror',lambda e:errors.append(str(e)))
    setup_page(multi)
    multi.locator('#humanCount').select_option('3')
    multi.locator('#botCount').select_option('0')
    multi.locator('[data-action="start"]').click()
    assert multi.locator('.hand-grid.player-hand-grid .hand-tile').count()==2
    assert multi.locator('.played [data-action="toggle-played"]').count()==1
    multi.locator('.played [data-action="toggle-played"]').click()
    assert multi.locator('.played.zone-folded').count()==1
    multi.locator('.hand-grid .card-create').click()
    assert multi.locator('.handoff-card').count()==1
    multi.locator('[data-action="ready"]').click()
    assert multi.locator('.handoff-card').count()==0
    assert not errors,errors
    print('3 名人类本地交接模式，整理与回收折叠兼容，通过')
    browser.close()
