"""手机需求自查补充回归：隐私恢复、长姓名、触控/弹层、排序、备份与无服务器离线。"""
import json, re, subprocess, threading
from pathlib import Path
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT.parent/'docs/mobile/self-audit';(OUT/'screenshots').mkdir(parents=True,exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/Century/'):self.path=self.path[len('/Century'):]
        super().do_GET()
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT/'dist')))
threading.Thread(target=server.serve_forever,daemon=True).start()
BASE=f'http://127.0.0.1:{server.server_port}/Century/';KEY='century-mobile-game-v2'
fixtures=json.loads(subprocess.check_output(['node','--input-type=module','-e',"""
import {createGame,applyAction} from './dist/js/engine.js';
const base=createGame(['玩家一','玩家二'],1);
let ai=createGame(['玩家一','玩家二','AI1','AI2','AI3'],1,[2,3,4]);ai=applyAction(ai,{type:'play',cardId:'S01'});ai=applyAction(ai,{type:'play',cardId:'S01'});
const long=structuredClone(base);long.players.forEach(p=>p.name='这是一个二十个汉字长度的玩家名字用于边界');
const many=structuredClone(base);many.players[0].hand=['S01','M20','M35'];many.players[0].played=['S02'];
const overflow=structuredClone(base);overflow.players[0].stock=[10,0,0,0];
console.log(JSON.stringify({base,ai,long,many,overflow}));
"""],cwd=ROOT))
results=[];errors=[]
def act(page,a):page.locator(f'[data-action="{a}"]').last.click()
def load(page,g):
    page.goto(BASE+'mobile/');page.evaluate('([key,g])=>{localStorage.clear();localStorage.setItem(key,JSON.stringify(g))}',[KEY,g]);page.reload();act(page,'resume')
    if page.locator('[data-action="ready"]').count():act(page,'ready')
def shot(page,name):page.screenshot(path=str(OUT/'screenshots'/name),animations='disabled')
def touch_targets(page,scope='body'):
    bad=page.locator(scope).locator('button:not(:disabled)').evaluate_all('''els=>els.filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.top<innerHeight}).map(e=>({action:e.dataset.action,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})).filter(e=>e.w<43.9||e.h<43.9)''')
    assert not bad,bad

def sheet_bounds(page):
    page.wait_for_function("document.querySelector('[role=dialog]').getAnimations().every(a=>a.playState!=='running')",timeout=3000)
    footer=page.locator('[data-action="confirm"]');box=footer.bounding_box();assert box and box['y']>=0 and box['y']+box['height']<=page.viewport_size['height']+1,box
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    touch_targets(page,'[role="dialog"]')
with sync_playwright() as pw:
    for engine in ('chromium','webkit'):
        browser=getattr(pw,engine).launch(headless=True)
        context=browser.new_context(viewport={'width':320,'height':640},is_mobile=True,has_touch=True)
        page=context.new_page();page.set_default_timeout(10000)
        page.on('pageerror',lambda e:errors.append(str(e)));page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        # AI 回合恢复时不能显示任何真人私人手牌；暂停后也不能泄露。
        load(page,fixtures['ai']);assert page.locator('.hand-tile').count()==0
        assert page.locator('[aria-label="私人手牌已隐藏"]').count()==1
        act(page,'pause');assert page.locator('.hand-tile').count()==0
        shot(page,f'{engine}-06-ai-resume-fixed.png')
        act(page,'pause');page.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key)).current===0',arg=KEY,timeout=45000)
        assert page.locator('.handoff').count()==1 and page.locator('.hand-tile').count()==0
        act(page,'ready');assert page.locator('.hand-tile').count()==1
        # 长姓名与两市场完整可见。
        load(page,fixtures['long']);metrics=page.evaluate('''()=>{const m=document.querySelector('.markets').getBoundingClientRect(),c=document.querySelector('.merchant-rail .card').getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,marketBottom:m.bottom,cardBottom:c.bottom}}''')
        assert metrics['scroll']==320 and metrics['cardBottom']<=metrics['marketBottom']+1,metrics
        shot(page,f'{engine}-07-long-name-fixed.png');touch_targets(page)
        # 被隐藏的已打出卡不应使“前移/后移”出现空操作；规则存档完全不变。
        load(page,fixtures['many']);page.evaluate('localStorage.setItem("century-mobile-order-v1",JSON.stringify({"0":["S01","S02","M20","M35"]}))');page.reload();act(page,'resume');act(page,'ready')
        original=page.evaluate('(key)=>localStorage.getItem(key)',KEY);act(page,'expand');act(page,'arrange');touch_targets(page)
        page.locator('[data-action="move"][data-id="S01"][data-delta="1"]').click()
        assert page.locator('.hand-tile').evaluate_all('els=>els.map(e=>e.dataset.card)')==['M20','S01','M35']
        assert page.evaluate('(key)=>localStorage.getItem(key)',KEY)==original
        shot(page,f'{engine}-08-order-fixed.png')
        # 所有指定视口下，升级/交易/获取/弃置确认区均可触达。
        for width,height in ((320,640),(375,812),(390,844),(430,932),(932,430)):
            page.set_viewport_size({'width':width,'height':height})
            for kind in ('upgrade','trade','acquire','discard'):
                game=json.loads(json.dumps(fixtures['many'] if kind=='trade' else fixtures['overflow'] if kind=='discard' else fixtures['base']))
                if kind=='trade':game['players'][0]['stock']=[6,0,0,0]
                load(page,game)
                if kind=='upgrade':page.locator('[data-action="play"][data-id="S02"]').click()
                elif kind=='trade':page.locator('[data-action="play"][data-id="M20"]').click()
                elif kind=='acquire':page.locator('[data-action="acquire"][data-index="2"]').click()
                else:page.locator('[data-action="play"][data-id="S01"]').click();act(page,'confirm')
                sheet_bounds(page)
                if width==320:shot(page,f'{engine}-09-{kind}-320.png')
        page.set_viewport_size({'width':390,'height':844})
        # 真实文件导入导出，支持同一来源桌面 v2 复制，不覆盖电脑存档。
        page.goto(BASE+'mobile/');page.evaluate('localStorage.clear()');page.reload()
        page.locator('#importSave').set_input_files({'name':'century-test.json','mimeType':'application/json','buffer':json.dumps(fixtures['base']).encode()})
        assert page.locator('.handoff').count()==1;act(page,'ready');act(page,'menu')
        with page.expect_download() as download:act(page,'export')
        assert json.loads(Path(download.value.path()).read_text())==fixtures['base']
        act(page,'cancel');act(page,'menu');act(page,'home')
        page.evaluate('(g)=>{localStorage.clear();localStorage.setItem("crystal-corridor-game-v2-canonical",JSON.stringify(g))}',fixtures['base']);page.reload()
        act(page,'import-desktop');assert page.locator('.handoff').count()==1
        assert page.evaluate('localStorage.getItem("crystal-corridor-game-v2-canonical")')==json.dumps(fixtures['base'],separators=(',',':'),ensure_ascii=False)
        # 真正 file:// 冷启动并禁网，网页无需任何 HTTP 服务也能完成一轮。
        cold=context.new_page();cold.on('pageerror',lambda e:errors.append(str(e)));cold.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        # WebKit 的全局 offline 模拟会连 file:// 导航本身也阻断；改为拦截所有 HTTP(S)。
        network=[];cold.on('request',lambda request:network.append(request.url) if request.url.startswith(('http://','https://')) else None)
        if engine=='webkit':context.route(re.compile(r'^https?://'),lambda route:route.abort())
        else:context.set_offline(True)
        cold.goto((ROOT/'dist/mobile/standalone.html').as_uri());cold.evaluate('localStorage.clear()');cold.reload()
        act(cold,'start');cold.locator('[data-action="play"][data-id="S01"]').click();act(cold,'confirm')
        cold.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key)).current===0',arg=KEY,timeout=45000)
        assert cold.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).players.every(p=>p.turns===1)',KEY)
        assert not network,network
        context.set_offline(False);cold.close()
        results.append({'engine':engine,'privacyResume':'pass','longName':metrics,'visibleHandReorder':'pass','touchTargets44':'pass','sheetViewports':20,'backupRoundTrip':'pass','desktopCopy':'pass','offlineFileColdStart':'pass','fileNetworkMode':'HTTP(S) blocked' if engine=='webkit' else 'offline','fileNetworkRequests':network})
        context.close();browser.close();print(engine,'self audit passed',flush=True)
server.shutdown();assert not errors,errors
(OUT/'results.json').write_text(json.dumps({'results':results,'errors':errors},ensure_ascii=False,indent=2))
print('补充自查全部通过')
