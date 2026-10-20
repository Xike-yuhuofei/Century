"""独立手机版真实浏览器验收：Chromium + WebKit，确定性边界局面经正式引擎执行。"""
import json, os, subprocess, threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT.parent/'docs/mobile/screenshots'
OUT.mkdir(parents=True, exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/Century/'):
            self.path=self.path[len('/Century'):]
        super().do_GET()
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT/'dist')))
threading.Thread(target=server.serve_forever,daemon=True).start()
BASE=f'http://127.0.0.1:{server.server_port}/Century/'
KEY='century-mobile-game-v2'
fixtures=json.loads(subprocess.check_output(['node','--input-type=module','-e',"""
import {createGame,applyAction} from './dist/js/engine.js';
import {MERCHANT_DECK,GOLEM_DECK} from './dist/js/data.js';
const make=(h=2,a=0)=>createGame(Array.from({length:h+a},(_,i)=>i<h?`玩家 ${i+1}`:`AI ${i-h+1}`),71,Array.from({length:a},(_,i)=>h+i));
const f={base:make(),solo:make(1,1),five:make(2,3),six:make(2,4)};
f.trade=make();f.trade.players[0].hand.push('M20');f.trade.players[0].stock=[6,0,0,0];
f.acquire=make();f.acquire.merchantMarket[2].bonus=[0,1,1,0];
f.overflow=make();f.overflow.players[0].stock=[10,0,0,0];
f.claim=make();f.claim.golemMarket[0]='G08';f.claim.players[0].stock=[2,2,0,0];
f.final=make();f.final.current=1;f.final.players[1].stock=[2,2,0,0];f.final.players[1].claimed=['G01','G02','G03','G04','G05'];f.final.golemMarket[0]='G08';
f.many=make();f.many.players[0].hand.push('M20','M23','M35','M43','M07','M18','M40','M41','M42');
f.bonus=make();f.bonus.merchantMarket[0].bonus=[15,4,3,2];
f.allMerchants=MERCHANT_DECK.map(c=>c.id);f.allGolems=GOLEM_DECK.map(c=>c.id);console.log(JSON.stringify(f));
"""],cwd=ROOT))
errors=[]; report=[]
canonical=json.loads((ROOT.parent/'data/cards.json').read_text())
colors=canonical['color_order']
expected={'merchants':{c['id']:{'kind':c['type'],'steps':c['upgrade_steps'],'input':[c['input'][color] for color in colors],'output':[c['output'][color] for color in colors]} for c in canonical['merchants']+canonical['starters']},'golems':{c['id']:{'cost':[c['need'][color] for color in colors],'points':c['points']} for c in canonical['golems']}}
def action(page,name): page.locator(f'[data-action="{name}"]').last.click()
def saved(page): return json.loads(page.evaluate('(key)=>localStorage.getItem(key)',KEY))
def resume(page,g):
    page.goto(BASE+'mobile/')
    page.evaluate('([key,g])=>{localStorage.clear();localStorage.setItem(key,JSON.stringify(g))}',[KEY,g])
    page.reload(); action(page,'resume')
    if page.locator('[data-action="ready"]').count(): action(page,'ready')
def shot(page,name):page.screenshot(path=str(OUT/name),animations='disabled')
def geometry(page):
    result=page.evaluate('''expected=>{
      const counts=el=>[0,1,2,3].map(c=>el.querySelectorAll('.gem-'+c).length),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
      const mismatch=[];
      for(const card of document.querySelectorAll('.card')){
        const id=card.querySelector('.card-top small').textContent;
        if(card.classList.contains('golem')){
          const data=expected.golems[id];
          if(!equal(counts(card.querySelector('.gems')),data.cost)||parseInt(card.querySelector('.points').textContent)!==data.points)mismatch.push(id);
        }else{
          const data=expected.merchants[id],groups=[...card.querySelectorAll('.effect>.gems')].map(counts);
          if(data.kind==='升级'){
            if(Number(card.querySelector('.upgrade-effect b').textContent)!==data.steps)mismatch.push(id);
          }else if(!equal(groups,data.kind==='创造'?[data.output]:[data.input,data.output]))mismatch.push(id);
        }
      }
      return {width:innerWidth,scroll:document.documentElement.scrollWidth,height:innerHeight,docHeight:document.documentElement.scrollHeight,mismatchedCards:mismatch,clipped:[...document.querySelectorAll('.card .gem')].filter(g=>!g.closest('.bonus')).filter(g=>{const a=g.getBoundingClientRect(),b=g.closest('.card').getBoundingClientRect();return a.top<b.top-1||a.bottom>b.bottom+1||a.left<b.left-1||a.right>b.right+1}).length};
    }''',expected)
    assert not result['mismatchedCards'],result
    return result
with sync_playwright() as pw:
    for engine in ('chromium','webkit'):
        browser=getattr(pw,engine).launch(headless=True)
        context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=1)
        page=context.new_page();page.set_default_timeout(10000)
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        page.goto(BASE+'mobile/');shot(page,f'{engine}-01-home.png')
        # 所有目标视口：两市场同时保留，局部横滑，不出现页面横向滚动。
        for w,h in [(320,640),(375,812),(390,844),(430,932),(932,430)]:
            page.set_viewport_size({'width':w,'height':h});resume(page,fixtures['solo'])
            stats=geometry(page);assert stats['scroll']<=w,stats;assert stats['clipped']==0,stats
            assert page.locator('.golem-rail .card').count()==5
            assert page.locator('.merchant-rail .card').count()==6
            assert page.locator('.hand-dock').bounding_box()['y']>=0
            market=page.locator('.markets').bounding_box();card=page.locator('.merchant-rail .card').first.bounding_box()
            assert card['y']+card['height']<=market['y']+market['height']+1, (w,h,market,card)
            shot(page,f'{engine}-02-table-{w}x{h}.png')
            report.append({'engine':engine,'viewport':f'{w}x{h}',**stats})
        # 设计验收：真实10张手牌与5+6公共卡牌，在375×667不滚动同时可见。
        page.set_viewport_size({'width':375,'height':667})
        resume(page,fixtures['many'])
        assert page.locator('.golem-rail .card').count()==5
        assert page.locator('.merchant-rail .card').count()==6
        assert page.locator('.tactical-grid .card').count()==10
        assert page.locator('.crystal-strip .gem-0').count()==fixtures['many']['players'][0]['stock'][0]
        board_visible=page.evaluate("""() => {
          const items=[...document.querySelectorAll('.golem-rail .card,.merchant-rail .card,.tactical-grid .card')];
          return items.length===21 && items.every(el=>{
            const r=el.getBoundingClientRect();
            return r.width>=44 && r.height>=44 && r.top>=0 && r.bottom<=innerHeight+1 && r.left>=0 && r.right<=innerWidth+1;
          }) && document.documentElement.scrollHeight<=innerHeight+1;
        }""")
        assert board_visible,'21张卡必须全屏可见且可点击'
        # 任意已打出卡牌保持原来的格位，不允许跳至最后一格。
        resume(page,fixtures['base'])
        page.locator('[data-action="play"][data-id="S01"]').click()
        action(page,'confirm')
        action(page,'ready')
        page.locator('[data-action="play"][data-id="S01"]').click()
        action(page,'confirm')
        action(page,'ready')
        assert page.locator('.tactical-grid .tactical-tile').first.get_attribute('data-card')=='S01'
        assert page.locator('.tactical-grid .tactical-tile').first.get_attribute('class').find('played-tile')>=0
        # 所有真实卡面在最小屏幕逐一通过，不遗漏高颗数交易或魔像。
        page.set_viewport_size({'width':320,'height':640})
        for offset in range(0,43,6):
            g=json.loads(json.dumps(fixtures['base']))
            g['merchantMarket']=[{'id':id,'bonus':[0,0,0,0]} for id in fixtures['allMerchants'][offset:offset+6]]
            g['golemMarket']=fixtures['allGolems'][offset:offset+5] or fixtures['base']['golemMarket']
            resume(page,g);assert geometry(page)['clipped']==0,(offset,geometry(page))
        for offset in range(0,36,5):
            g=json.loads(json.dumps(fixtures['base']));g['golemMarket']=fixtures['allGolems'][offset:offset+5]
            resume(page,g);assert geometry(page)['clipped']==0,('golems',offset,geometry(page))
        page.set_viewport_size({'width':390,'height':844})
        # 升级同一颗 黄->绿->蓝，撤销一次后仅升一次；取消完全不改变存档。
        resume(page,fixtures['base']); page.locator('[data-action="play"][data-id="S02"]').click()
        page.locator('[data-action="upgrade"][data-color="0"]').click()
        page.locator('[data-action="upgrade"][data-color="1"]').click()
        assert page.locator('#sheet-title').inner_text().endswith('2 / 2 次');shot(page,f'{engine}-03-upgrade.png')
        action(page,'undo');action(page,'confirm');assert saved(page)['players'][0]['stock']==[2,1,0,0]
        assert page.locator('.handoff').count()==1 and page.locator('.hand-dock').count()==0
        shot(page,f'{engine}-04-handoff.png')
        page.reload();action(page,'resume');assert page.locator('.handoff').count()==1
        action(page,'ready');assert '玩家 2' in page.locator('.dock-title').inner_text()
        resume(page,fixtures['base']);page.locator('[data-id="S02"][data-action="play"]').click();action(page,'confirm')
        assert saved(page)['players'][0]['stock']==[3,0,0,0] # 零次合法升级
        resume(page,fixtures['base']);page.locator('[data-id="S02"][data-action="play"]').click()
        page.locator('[data-action="upgrade"][data-color="0"]').click();action(page,'cancel');assert saved(page)['turnNumber']==1
        # 合法连续交易：6黄 -> 6绿，不能多选。
        resume(page,fixtures['trade']);page.locator('[data-action="play"][data-id="M20"]').click();action(page,'plus');action(page,'plus')
        assert page.locator('[data-action="plus"]').is_disabled();shot(page,f'{engine}-05-trade.png');action(page,'confirm');assert saved(page)['players'][0]['stock']==[0,6,0,0]
        # 获取压晶分配给左侧每卡，卡上奖励收回。
        resume(page,fixtures['acquire']);page.locator('[data-action="acquire"][data-index="2"]').click()
        page.locator('[data-action="pick"][data-color="0"]').click();page.locator('[data-action="pick"][data-color="0"]').click()
        shot(page,f'{engine}-06-payment.png');action(page,'confirm');g=saved(page)
        assert g['players'][0]['stock']==[1,1,1,0]
        assert g['merchantMarket'][0]['bonus']==[1,0,0,0] and g['merchantMarket'][1]['bonus']==[1,0,0,0]
        resume(page,fixtures['base']);page.locator('[data-action="acquire"][data-index="0"]').click();action(page,'confirm');assert len(saved(page)['players'][0]['hand'])==3
        resume(page,fixtures['base']);page.locator('[data-action="acquire"][data-index="5"]').click()
        for _ in range(3):page.locator('[data-action="pick"][data-color="0"]').click()
        assert page.locator('[data-action="confirm"]').is_disabled();action(page,'cancel')
        # 创造/商队超额，刷新恢复后仍必须弃置，不能靠取消跳过。
        resume(page,fixtures['overflow']);page.locator('[data-action="play"][data-id="S01"]').click();action(page,'confirm')
        assert saved(page)['phase']=='overflow';shot(page,f'{engine}-07-discard.png')
        action(page,'cancel');assert page.locator('[data-action="discard-open"]').is_visible();action(page,'discard-open')
        page.reload();action(page,'resume');action(page,'ready')
        for _ in range(2):page.locator('[data-action="pick"][data-color="0"]').click()
        action(page,'confirm');assert saved(page)['players'][0]['stock']==[10,0,0,0]
        # 认领精确支付+铜币；缺晶可以查看但不能确认。
        resume(page,fixtures['claim']);page.locator('[data-action="claim"][data-index="0"]').click();shot(page,f'{engine}-08-claim.png');action(page,'confirm')
        g=saved(page);assert g['players'][0]['stock']==[0,0,0,0] and g['players'][0]['copper']==1
        resume(page,fixtures['base']);page.locator('[data-action="claim"][data-index="0"]').click();assert page.locator('[data-action="confirm"]').is_disabled()
        # 回收正面卡牌，并完成休息。
        rest=fixtures['base'].copy();rest=json.loads(json.dumps(rest));rest['players'][0]['hand']=['S02'];rest['players'][0]['played']=['S01']
        resume(page,rest);action(page,'played');assert page.locator('.played-rail .card').count()==1
        action(page,'rest');action(page,'confirm');assert saved(page)['players'][0]['played']==[]
        # 手牌展开、分类、触屏手柄拖动、顺序刷新持久化。
        resume(page,fixtures['many']);action(page,'expand');shot(page,f'{engine}-09-hand-expanded.png')
        page.locator('[data-action="filter"][data-filter="trade"]').click();assert page.locator('.hand-grid .card').count()==4
        page.locator('[data-action="filter"][data-filter="all"]').click();action(page,'group');action(page,'arrange')
        first=page.locator('[data-drag]').nth(0);second=page.locator('[data-drag]').nth(1)
        a=first.bounding_box();b=second.bounding_box()
        if engine=='chromium':
            session=context.new_cdp_session(page)
            session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':a['x']+a['width']/2,'y':a['y']+a['height']/2}]})
            session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':b['x']+b['width']/2,'y':b['y']+b['height']/2}]})
            session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
            session.detach()
        else:
            page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);page.mouse.down();page.mouse.move(b['x']+b['width']/2,b['y']+b['height']/2,steps=5);page.mouse.up()
        order=page.evaluate('JSON.parse(localStorage.getItem("century-mobile-order-v1"))["0"]')
        assert order[0]=='M35',order
        page.reload();action(page,'resume');action(page,'ready');assert page.locator('.hand-tile').first.get_attribute('data-card')=='M35'
        # 高奖励数量也不使卡面/页面溢出。
        resume(page,fixtures['bonus']);assert geometry(page)['clipped']==0;assert page.locator('.merchant-rail .card').first.locator('.bonus .gem').count()==24
        # 结算由正式引擎触发，计分逐项展示。
        resume(page,fixtures['final']);page.locator('[data-action="claim"][data-index="0"]').click();action(page,'confirm')
        assert saved(page)['phase']=='finished';assert page.locator('.results').count()==1;shot(page,f'{engine}-10-results.png')
        # 实际 AI Worker：1+1 / 2+3 / 2+4 均让整轮实际执行。
        for key in ('solo','five','six'):
            resume(page,fixtures[key]);page.locator('[data-action="play"][data-id="S01"]').click();action(page,'confirm')
            if key!='solo':
                action(page,'ready');page.locator('[data-action="play"][data-id="S01"]').click();action(page,'confirm')
            page.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key)).current===0',arg=KEY,timeout=45000)
            g=saved(page);assert all(p['turns']==1 for p in g['players']),g
            if key!='solo':assert page.locator('.handoff').count()==1
        # 指纹模块入口也能运行同一视图及 Worker。
        page.goto(BASE+'mobile/modules.html');page.evaluate('localStorage.clear()');page.reload();action(page,'start')
        page.locator('[data-action="play"][data-id="S01"]').click();action(page,'confirm')
        page.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key)).current===0',arg=KEY,timeout=45000)
        assert all(p['turns']==1 for p in saved(page)['players'])
        # 手机与桌面在同一来源独立存档。
        mobile_save=page.evaluate('(key)=>localStorage.getItem(key)',KEY)
        desktop=context.new_page();desktop.goto(BASE);desktop.locator('[data-action="start"]').click()
        assert desktop.locator('.duel-board,.focus-board').count()>=1
        assert desktop.evaluate('(key)=>localStorage.getItem(key)',KEY)==mobile_save
        desktop.close()
        # 完整离线 HTML 不依赖任何请求；断网兼容路径仍运行同一 AI 2.0。
        offline=context.new_page();offline.on('pageerror',lambda e:errors.append(str(e)))
        offline.goto(BASE+'mobile/standalone.html');offline.evaluate('localStorage.clear()');offline.reload()
        context.set_offline(True);action(offline,'start');offline.locator('[data-action="play"][data-id="S01"]').click();action(offline,'confirm')
        offline.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key)).current===0',arg=KEY,timeout=45000)
        assert all(p['turns']==1 for p in saved(offline)['players']);context.set_offline(False)
        offline.close();context.close();browser.close()
        print(engine,'all mobile flows passed',flush=True)
server.shutdown()
assert not errors,errors
(ROOT.parent/'docs/mobile/browser-results.json').write_text(json.dumps({'viewports':report,'errors':errors,'flows':'四类行动、连续升级、零次升级、重复交易、费用压晶、免费获取、缺晶、超额弃置与刷新恢复、双真人交接、触屏排序、分类、24颗奖励、终局、实际 AI 三种配置、桌面独立、断网离线 HTML'},ensure_ascii=False,indent=2))
print('MOBILE 浏览器验收通过')
