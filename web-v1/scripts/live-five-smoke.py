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
    width_0 = page.locator('.five-player[data-side="0"]').evaluate("(e)=>e.getBoundingClientRect().width")
    # Check 1/2/3 bots do not change fixed human side widths.
    for bots in [1, 2]:
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator('[data-action="reset"]').click()
        page.locator("#botCount").select_option(str(bots))
        page.locator('[data-action="start"]').click()
        assert page.locator(".five-ai-item:not(.five-ai-empty)").count() == bots
        assert abs(page.locator('.five-player[data-side="0"]').evaluate("(e)=>e.getBoundingClientRect().width") - width_0) < 4
    # Reset to 0 bots for deterministic paid acquisition and golem claim.
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator('[data-action="reset"]').click()
    page.locator("#botCount").select_option("0")
    page.locator('[data-action="start"]').click()
    # Paid position-3 merchant requires exactly two crystals on preceding cards.
    page.locator('.five-merchant-grid [data-action="get-merchant"]').nth(2).click()
    assert page.locator('.five-workbench .five-inline-modal').count() == 1
    page.locator('.five-workbench [data-action="payment-pick"][data-color="0"]').click()
    page.locator('.five-workbench [data-action="payment-pick"][data-color="0"]').click()
    page.locator('.five-workbench [data-action="confirm-acquire"]').click()
    assert page.locator('.five-player[data-side="0"] .five-hand-cards .merchant-card').count() == 3
    assert page.locator(".five-merchant-grid .merchant-card").count() == 6
    # Force a legal own-turn claim state through the same persisted game schema.
    canonical = json.loads(root.parent.joinpath("data/cards.json").read_text("utf-8"))
    first_golem = page.evaluate("""() => {
        const key='crystal-corridor-game-v2-canonical';
        const game=JSON.parse(localStorage.getItem(key));
        game.current=0;game.phase='turn';
        localStorage.setItem(key,JSON.stringify(game));
        return game.golemMarket[0];
    }""")
    need = next(c["need"] for c in canonical["golems"] if c["id"] == first_golem)
    stock = [need[c] for c in canonical["color_order"]]
    page.evaluate("""s => {
        const key='crystal-corridor-game-v2-canonical';
        const game=JSON.parse(localStorage.getItem(key));
        game.players[0].stock=s;
        localStorage.setItem(key,JSON.stringify(game));
    }""", stock)
    page.reload()
    page.locator('.five-golem-grid [data-action="claim"]').first.click()
    assert "魔像 1 张" in page.locator('.five-player[data-side="0"] .five-player-foot').inner_text()
    assert page.locator('.five-player[data-side="1"].five-active').count() == 1
    # Human player count can be selected 1 or 2. The hidden P2 name must survive mode changes.
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator('[data-action="reset"]').click()
    page.locator('#nameInputs input').nth(1).fill('右侧真人')
    page.locator('#humanCount').select_option("1")
    assert page.locator('#nameInputs input:visible').count() == 1
    assert page.locator('#nameInputs input').nth(1).input_value() == '右侧真人'
    page.locator('#humanCount').select_option("2")
    assert page.locator('#nameInputs input:visible').count() == 2
    assert page.locator('#nameInputs input').nth(1).input_value() == '右侧真人'

    # Solo human / no bot is invalid, and never starts a one-person game.
    page.locator('#humanCount').select_option("1")
    page.locator('#botCount').select_option("0")
    assert page.locator('[data-action="start"]').is_disabled()
    assert '至少需要 1 名 AI' in page.locator('#setupValidation').inner_text()

    # One human plus 1, 2, or 3 bots must all use the dedicated human-vs-AI board.
    for bots in [1, 2, 3]:
        page.locator('#botCount').select_option(str(bots))
        assert page.locator('[data-action="start"]').is_enabled()
        page.locator('[data-action="start"]').click()
        assert page.locator('.ai-board-layout').count() == 1
        assert page.locator('.ai-arena > .duel-player').count() == 1
        assert page.locator('.ai-seat-grid .ai-seat').count() == bots
        assert page.locator('.ai-board-layout .golem-grid .golem-card').count() == 5
        assert page.locator('.ai-board-layout .merchant-grid .merchant-card').count() == 6
        assert page.locator('.handoff-card').count() == 0
        state = page.evaluate("() => JSON.parse(localStorage.getItem('crystal-corridor-game-v2-canonical'))")
        assert len(state["players"]) == bots + 1
        assert sum(not player["isAI"] for player in state["players"]) == 1
        if bots == 1:
            page.locator('.ai-arena .duel-player [data-action="play-hand"].card-create').click()
            page.wait_for_function(
                "() => {const g=JSON.parse(localStorage.getItem('crystal-corridor-game-v2-canonical'));return g.players[1].turns>=1 && g.current===0;}",
                timeout=12000
            )
            assert page.locator('.ai-arena > .duel-player.duel-active').count() == 1
            assert page.locator('.handoff-card').count() == 0
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator('[data-action="reset"]').click()
        page.locator('#humanCount').select_option("1")

    # Double-human without AI remains valid.
    page.locator('#humanCount').select_option("2")
    page.locator('#botCount').select_option("0")
    assert page.locator('[data-action="start"]').is_enabled()
    page.locator('[data-action="start"]').click()
    assert page.locator('.five-player').count() == 2
    assert page.locator('.five-ai-item:not(.five-ai-empty)').count() == 0
    assert errors == [], errors
    print("1–2 真人/0–3 AI UI E2E 通过：开局组合校验、名称保留、单人 AI 自动回合、双人固定同屏及四类行动")
    browser.close()
