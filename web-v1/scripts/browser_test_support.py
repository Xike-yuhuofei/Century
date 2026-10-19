"""共享浏览器启动：支持 CHROME_BIN、本机 Chrome 或 Playwright Chromium。"""
import os
import shutil
from pathlib import Path


def launch_browser(playwright):
    binary = os.environ.get('CHROME_BIN') or shutil.which('chromium')
    mac_chrome = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not binary and mac_chrome.exists():
        binary = str(mac_chrome)
    options = dict(headless=True, args=['--no-sandbox'])
    if binary:
        options['executable_path'] = binary
    return playwright.chromium.launch(**options)
