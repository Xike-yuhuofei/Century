"""兼容入口：以最新 Focus 布局验证双人 + 0–4 AI。"""
from pathlib import Path
from runpy import run_path
run_path(str(Path(__file__).with_name('smoke_focus.py')), run_name='__main__')
