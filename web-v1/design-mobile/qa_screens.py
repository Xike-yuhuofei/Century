#!/usr/bin/env python3
"""Century 手机 UI 概念演示 · 视觉 QA 脚本
双引擎(Chromium/WebKit) × 四视口，验证：
- 页面无滚动、21 张卡完整、无元素溢出视口
- 关键操作命中区 ≥44px
- 全交互流程截图（认领/获取/交易/升级/休息/弃置/管理/菜单）
产物: design-mobile/shots/*.png + 控制台验收报告
"""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
SHOTS = HERE / "shots"
SHOTS.mkdir(exist_ok=True)
URL = "http://localhost:4199/"
VIEWPORTS = [(320, 640), (375, 667), (390, 844), (430, 932)]

AUDIT_JS = """() => {
  const d = document.scrollingElement;
  const overflows = [];
  document.querySelectorAll('.card,.gem,.slot-empty,.pchip,.cta,.coin').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1)
      overflows.push(el.className.split(' ').slice(0,2).join('.') + ':' + Math.round(r.right) + 'x' + Math.round(r.bottom));
  });
  const smallTaps = [];
  document.querySelectorAll('.icon-btn,.manage,.cta,.stepbtn,.sheet-head .x').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.width < 43 || r.height < 43)) smallTaps.push(el.className + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
  });
  return {
    vp: [innerWidth, innerHeight],
    scroll: d.scrollHeight - Math.round(innerHeight),
    golems: document.querySelectorAll('.golem').length,
    mers: document.querySelectorAll('#merGrid .card').length,
    handTiles: document.querySelectorAll('#handGrid .tile').length,
    gemsInCaravan: document.querySelectorAll('#slots .gem').length,
    emptySlots: document.querySelectorAll('#slots .slot-empty').length,
    overflowCount: overflows.length,
    overflowSample: overflows.slice(0, 6),
    smallTaps,
  };
}"""

def audit(page):
    return page.evaluate(AUDIT_JS)

def run_engine(engine, pw):
    browser = getattr(pw, engine).launch()
    report = {"engine": engine, "viewports": {}, "flows": {}}
    ctx = browser.new_context(viewport={"width": 390, "height": 844},
                              device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.goto(URL, wait_until="networkidle")
    # ---- 四视口静态审计 + 首屏截图 ----
    for w, h in VIEWPORTS:
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(120)
        m = audit(page)
        page.screenshot(path=SHOTS / f"{w}x{h}-home-{engine}.png")
        report["viewports"][f"{w}x{h}"] = m
    page.set_viewport_size({"width": 390, "height": 844})
    page.reload(wait_until="networkidle")

    def shot(name):
        page.wait_for_timeout(160)
        page.screenshot(path=SHOTS / f"390-{name}-{engine}.png")

    def tap(sel, nth=0):
        page.locator(sel).nth(nth).tap()

    try:
        # 交易浮层
        tap('[data-id="M20"]'); shot("sheet-trade")
        tap('.sheet-head .x')
        # 获取浮层（位置1 M24，付 1 蓝）
        tap('[data-act="acquire"]', 1)
        page.locator('#payPicker .pick').nth(2).tap()
        shot("sheet-acquire")
        tap('.sheet-foot .cta'); page.wait_for_timeout(240)
        shot("after-acquire")
        # 超限链: M42(+2)->8, M36(+1)->9, 获取M38(idx1,付1黄)->8, 经管理面板打出(+3)->11 → 弃置 1
        tap('[data-id="M42"]'); tap('.sheet-foot .cta'); page.wait_for_timeout(160)
        tap('[data-id="M36"]'); tap('.sheet-foot .cta'); page.wait_for_timeout(160)
        tap('[data-act="acquire"]', 1)          # M38 现位于 idx1
        page.locator('#payPicker .pick').nth(0).tap()  # 黄 ×1
        tap('.sheet-foot .cta'); page.wait_for_timeout(160)
        # M38 已超出固定 10 格 → 经「手牌管理」打出
        tap('#manageBtn')
        page.locator('[data-act="manage-play"][data-id="M38"]').tap()
        tap('.sheet-foot .cta'); page.wait_for_timeout(240)
        shot("sheet-discard")                    # 弃置 1
        page.locator('#disPicker .pick').nth(2).tap()   # 弃蓝
        tap('.sheet-foot .cta'); page.wait_for_timeout(160)
        # 认领浮层（G08 仍可认领：黄2绿2）
        tap('[data-act="claim"]', 4); shot("sheet-claim")
        tap('.sheet-foot .cta'); page.wait_for_timeout(240)
        shot("after-claim")
        # 升级浮层
        tap('[data-id="S02"]')
        page.locator('#upPicker .pick').nth(0).tap()
        shot("sheet-upgrade")
        tap('.sheet-head .x')
        # 休息 / 管理 / 菜单 / 帮助
        tap('#restBtn'); shot("sheet-rest"); tap('.sheet-foot .cta')
        tap('#manageBtn'); shot("sheet-manage"); tap('.sheet-foot .cta')
        tap('#menuBtn'); shot("sheet-menu")
        tap('[data-act="help"]'); shot("sheet-help")
        report["flows"][engine] = "all sheets captured"
    except Exception as e:
        report["flows"][engine] = f"FLOW ERROR: {e}"
    ctx.close(); browser.close()
    return report

def main():
    summary = {}
    with sync_playwright() as pw:
        for engine in ("chromium", "webkit"):
            r = run_engine(engine, pw)
            ok = True
            for vp, m in r["viewports"].items():
                probs = []
                if m["scroll"] > 0: probs.append(f"页面滚动 {m['scroll']}px")
                if m["golems"] != 5 or m["mers"] != 6 or m["handTiles"] != 10:
                    probs.append(f"卡数 {m['golems']}+{m['mers']}+{m['handTiles']}")
                if m["overflowCount"]: probs.append(f"溢出 {m['overflowSample']}")
                if m["smallTaps"]: probs.append(f"命中区 {m['smallTaps']}")
                summary[f"{engine} {vp}"] = "PASS" if not probs else "FAIL: " + "; ".join(probs)
                if probs: ok = False
            if "ERROR" in str(r["flows"]): ok = False
            summary[f"{engine} flows"] = r["flows"][engine]
    print(json.dumps(summary, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
