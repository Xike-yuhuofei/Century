"""真实引擎驱动五人超宽屏浏览器冒烟测试。
CI: pip install playwright; on GitHub runner uses installed Google Chrome.
"""
from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
html = root.joinpath("dist/standalone.html").resolve()
with sync_playwright() as p:
    # GitHub hosted Ubuntu has Google Chrome; local setup can supply CHROME_BIN.
    binary = os.environ.get("CHROME_BIN")
    kwargs = dict(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    if binary:
        kwargs["executable_path"] = binary
    else:
        kwargs["channel"] = "chrome"
    browser = p.chromium.launch(**kwargs)
    page = browser.new_page(viewport={"width": 3440, "height": 1440})
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.goto(html.as_uri())
    assert page.locator("#humanCount").input_value() == "2"
    assert page.locator("#botCount").input_value() == "3"
    page.locator('[data-action="start"]').click()
    assert page.locator(".five-player").count() == 2
    assert page.locator(".five-ai-item:not(.five-ai-empty)").count() == 3
    assert page.locator(".five-golem-grid .golem-card").count() == 5
    assert page.locator(".five-merchant-grid .merchant-card").count() == 6
    assert page.locator(".overlay.cover").count() == 0
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
    assert page.evaluate("document.documentElement.scrollHeight <= innerHeight + 1")
    positions = page.locator(".five-player").evaluate_all(
        "(els) => els.map(el=>({x:el.getBoundingClientRect().x,w:el.getBoundingClientRect().width}))"
    )
    assert positions[0]["x"] < 100 and positions[1]["x"] > 1800
    assert abs(positions[0]["w"] - positions[1]["w"]) < 4

    # UI-only sorting and DnD do not spend a game turn.
    page.locator('.five-player[data-side="0"] [data-action="five-sort"][data-mode="type"]').click()
    page.locator('.five-player[data-side="0"] [data-action="five-sort"][data-mode="manual"]').click()
    cards = page.locator('.five-player[data-side="0"] .five-hand-cards .merchant-card')
    before = cards.evaluate_all("(es)=>es.map(e=>e.dataset.id)")
    cards.first.drag_to(cards.last)
    after = cards.evaluate_all("(es)=>es.map(e=>e.dataset.id)")
    assert before != after, (before, after)
    assert page.locator(".five-turn").inner_text().startswith("第 1 手")
    page.locator('.five-player[data-side="0"] [data-action="five-fold"]').click()
    assert "five-folded" in page.locator('.five-player[data-side="0"] .five-played-zone').get_attribute("class")
    page.locator('.five-player[data-side="0"] [data-action="five-fold"]').click()

    # Play a real creation card; both players remain visible, no pass screen.
    page.locator('.five-player[data-side="0"] [data-action="play-hand"].card-create').click()
    assert page.locator('.five-player[data-side="0"] .five-played-cards .played-face').count() == 1
    assert page.locator('.five-player[data-side="1"].five-active').count() == 1
    page.locator('.five-player[data-side="1"] [data-action="play-hand"].card-upgrade').click()
    assert page.locator(".five-workbench .five-inline-modal").count() == 1
    page.locator('[data-action="upgrade-step"][data-color="0"]').click()
    page.locator('[data-action="upgrade-step"][data-color="1"]').click()
    page.locator('[data-action="confirm-upgrade"]').click()

    # 3 bots take their turns without human handoff or human panels disappearing.
    page.wait_for_function(
        "() => !!document.querySelector('.five-player[data-side=\"0\"].five-active')",
        timeout=25000
    )
    assert page.locator(".five-player").count() == 2
    assert page.locator(".five-ai-item:not(.five-ai-empty)").count() == 3
    assert page.locator(".overlay.cover").count() == 0
    assert page.locator(".five-turn").inner_text().startswith("第 6 手")
    # Human P1 rest from played cards; real engine immediately advances.
    page.locator('.five-player[data-side="0"] [data-action="rest"]').click()
    assert page.locator('.five-player[data-side="0"] .five-played-cards .played-face').count() == 0
    assert page.locator('.five-player[data-side="1"].five-active').count() == 1

    # Reset and inspect option 0 AI without affecting both human slots.
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator('[data-action="reset"]').click()
    page.locator("#botCount").select_option("0")
    page.locator('[data-action="start"]').click()
    assert page.locator(".five-ai-item:not(.five-ai-empty)").count() == 0
    assert page.locator(".five-player").count() == 2
    assert errors == [], errors
    print("五人真实引擎端到端测试通过：固定双真人、3 AI、拖拽、排序、折叠、升级、休息、无移交遮罩、0 AI")
    browser.close()
