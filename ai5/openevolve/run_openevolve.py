# AI5 OpenEvolve 运行器：注入 codex exec 后端后调用 openevolve-run 主流程。
#
# 用法（等价 openevolve-run 的参数）：
#   .venv/bin/python run_openevolve.py program/acquisition_value.ts \
#     century_evaluator.py --config config.yaml --iterations 10 \
#     --output results/openevolve-run-controlled
#
# 说明：
# - provider 名保持 config.yaml 中的 "codex_app_server"，但经
#   openevolve.llm.ensemble._PROVIDER_REGISTRY 重定向到本项目的
#   CodexExecLLM（`codex exec --json` 子进程后端）。原因见
#   century_codex_exec.py 文件头（app-server 路径实测过慢）。
# - 不修改 OpenEvolve 源码；配置、数据库、控制器全部走上游原生路径。

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from century_codex_exec import CodexExecLLM  # noqa: E402

import openevolve.llm.ensemble as _ensemble  # noqa: E402

# 把 "codex_app_server" provider 重定向到 codex exec 后端（父进程，幂等）。
_ENSEMBLE_PROVIDER_KEY = "codex_app_server"
if getattr(_ensemble, "_century_exec_patched", False) is False:
    _ensemble._PROVIDER_REGISTRY[_ENSEMBLE_PROVIDER_KEY] = lambda cfg: CodexExecLLM(cfg)
    _ensemble._century_exec_patched = True


def _install_sitecustomize() -> None:
    """把 provider 重定向安装为 venv 级 sitecustomize —— multiprocessing spawn
    出的 worker 进程会重建 LLM ensemble（config 从 pickled dict 恢复，函数对象
    无法存活），sitecustomize 是唯一能覆盖所有子进程的注入点。"""
    import site
    import shutil
    for sp in site.getsitepackages():
        if not sp.endswith("site-packages"):
            continue
        target = Path(sp) / "sitecustomize.py"
        template = Path(__file__).resolve().parent / "venv_sitecustomize.py"
        content = template.read_text().replace(
            "@AI5_ROOT@", str(Path(__file__).resolve().parent)
        )
        if not target.exists() or target.read_text() != content:
            target.write_text(content)
        break


_install_sitecustomize()

from openevolve.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.argv[0] = "openevolve-run"
    main()
