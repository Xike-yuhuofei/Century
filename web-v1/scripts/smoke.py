"""兼容入口：V1.4 双人 + AI 视口和交互回归。"""
from pathlib import Path
from runpy import run_path
run_path(str(Path(__file__).with_name('smoke_human_ai.py')), run_name='__main__')
