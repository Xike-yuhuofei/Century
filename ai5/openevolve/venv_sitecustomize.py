# 此文件由 ai5/openevolve/run_openevolve.py 自动生成并安装到
# .venv/lib/python3.*/site-packages/sitecustomize.py。
# 作用：在本 venv 的每个 Python 进程（含 multiprocessing spawn 的 OpenEvolve
# worker）启动时，把 openevolve 的 codex_app_server provider 重定向到
# CodexExecLLM（`codex exec --json` 后端，理由见 century_codex_exec.py）。
# 不修改 OpenEvolve 源码；删除本文件即恢复上游行为。
import sys

_AI5_ROOT = "@AI5_ROOT@"
if _AI5_ROOT not in sys.path:
    sys.path.insert(0, _AI5_ROOT)

try:
    from century_codex_exec import CodexExecLLM
    import openevolve.llm.ensemble as _ens

    if getattr(_ens, "_century_exec_patched", False) is False:
        _ens._PROVIDER_REGISTRY["codex_app_server"] = lambda cfg: CodexExecLLM(cfg)
        _ens._century_exec_patched = True
except Exception:  # noqa: BLE001 —— sitecustomize 静默失败，不影响普通 python 用途
    pass
