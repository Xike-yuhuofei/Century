#!/usr/bin/env python3
"""AI 5.0 环境审查（任务一）：记录环境版本、验证 MPS 实际计算、检查常用算子兼容性与内存状况。

仅用于基准测试，不修改 AI 4.0 正式算法。输出 JSON 至 results/env_audit.json。
运行：~/century-ai5-env/bin/python exp1_env_audit.py
"""

import json
import platform
import subprocess
import sys
import time
from pathlib import Path

import torch

RESULTS_DIR = Path(__file__).resolve().parent / "results"


def sh(cmd: str) -> str:
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15).stdout.strip()
    except Exception as exc:  # noqa: BLE001
        return f"<error: {exc}>"


def system_info() -> dict:
    return {
        "python": sys.version.split()[0],
        "pytorch": torch.__version__,
        "torch_cuda_compiled": bool(torch.backends.cuda.is_built()),
        "mps_built": bool(torch.backends.mps.is_built()),
        "mps_available": bool(torch.backends.mps.is_available()),
        "macos": sh("sw_vers -productVersion"),
        "macos_build": sh("sw_vers -buildVersion"),
        "chip": sh("sysctl -n machdep.cpu.brand_string"),
        "cpu_cores": sh("sysctl -n hw.ncpu"),
        "perf_cores": sh("sysctl -n hw.perflevel0.physicalcpu"),
        "efficiency_cores": sh("sysctl -n hw.perflevel1.physicalcpu"),
        "unified_memory_bytes": int(sh("sysctl -n hw.memsize") or 0),
        "node_version": sh("node --version"),
        "platform": platform.platform(),
    }


def mps_correctness() -> dict:
    """在 MPS 与 CPU 上执行同一组确定性计算，逐项比对结果。"""
    torch.manual_seed(0)
    checks = {}

    def compare(name: str, fn):
        try:
            with torch.no_grad():
                cpu = fn(torch.device("cpu"))
                mps = fn(torch.device("mps"))
            checks[name] = {
                "ok": bool(torch.allclose(cpu.cpu(), mps.cpu(), atol=1e-4, rtol=1e-4)),
                "max_abs_diff": float((cpu.cpu() - mps.cpu()).abs().max()),
            }
        except Exception as exc:  # noqa: BLE001
            checks[name] = {"ok": False, "error": str(exc)[:200]}

    a = torch.randn(256, 256)
    b = torch.randn(256, 256)
    compare("matmul_256", lambda d: a.to(d) @ b.to(d))
    x = torch.randn(64, 128, 256)
    w = torch.randn(64, 256)  # F.linear 权重朝向：(out_features, in_features)
    bias = torch.randn(64)
    compare("linear_chain", lambda d: (torch.nn.functional.linear(x.to(d), w.to(d), bias.to(d)).relu()))
    img = torch.randn(2, 3, 32, 32)
    conv = torch.nn.Conv2d(3, 8, 3, padding=1)
    compare("conv2d", lambda d: conv.to(d)(img.to(d)))
    ln = torch.nn.LayerNorm(256)
    compare("layer_norm", lambda d: ln.to(d)(x.to(d)))
    emb = torch.nn.Embedding(1000, 32)
    idx = torch.randint(0, 1000, (64, 50))
    compare("embedding", lambda d: emb.to(d)(idx.to(d)))
    compare("softmax", lambda d: torch.softmax(x.to(d), dim=-1))
    compare("gelu", lambda d: torch.nn.functional.gelu(x.to(d)))
    compare("masked_fill", lambda d: x.to(d).masked_fill(x.to(d) > 0, -1e9))
    compare("cumsum", lambda d: x.to(d).cumsum(dim=1))
    compare("topk", lambda d: torch.topk(x.to(d), k=8, dim=-1).values)
    gidx = torch.randint(0, 128, x.shape)  # 索引固定，避免 CPU/MPS 两次调用取不同随机数
    compare("gather", lambda d: torch.gather(x.to(d), 1, gidx.to(d)))
    compare("where", lambda d: torch.where(x.to(d) > 0, x.to(d), torch.zeros_like(x.to(d))))
    logits = torch.randn(64, 10)
    target = torch.randint(0, 10, (64,))
    compare("cross_entropy", lambda d: torch.nn.functional.cross_entropy(logits.to(d), target.to(d)))
    compare("mse_loss", lambda d: torch.nn.functional.mse_loss(x.to(d), torch.zeros_like(x.to(d))))

    return {
        "all_ok": all(v.get("ok", False) for v in checks.values()),
        "checks": checks,
    }


def mps_compute_speed_probe() -> dict:
    """MPS 实际计算是否正常工作的快速探测（而非仅 is_available() 检查）。"""
    dev = torch.device("mps")
    torch.manual_seed(0)
    a = torch.randn(1024, 1024, device=dev)
    b = torch.randn(1024, 1024, device=dev)
    for _ in range(3):  # 预热
        a @ b
    torch.mps.synchronize()
    t0 = time.perf_counter()
    n = 20
    for _ in range(n):
        a @ b
    torch.mps.synchronize()
    ms = (time.perf_counter() - t0) / n * 1000
    tflops = 2 * 1024**3 / (ms / 1000) / 1e12
    return {"matmul_1024_ms": round(ms, 3), "approx_tflops": round(tflops, 2)}


def memory_report() -> dict:
    """CPU/GPU（统一内存）占用快照。"""
    total = int(sh("sysctl -n hw.memsize") or 0)
    vm_stat = sh("vm_stat")
    free_pages = 0
    for line in vm_stat.splitlines():
        if line.startswith("Pages free"):
            free_pages = int(line.split(":")[1].strip().rstrip("."))
    page_size = 16384  # Apple Silicon macOS 默认页大小
    free_gb = free_pages * page_size / 1e9
    return {
        "unified_memory_gb": round(total / 1e9, 1),
        "free_pages": free_pages,
        "free_estimate_gb": round(free_gb, 2),
        "swap_usage": sh("sysctl -n vm.swapusage"),
        "mps_allocated_mb": round(torch.mps.current_allocated_memory() / 1e6, 1),
        "mps_driver_allocated_mb": round(torch.mps.driver_allocated_memory() / 1e6, 1),
    }


def stress_stability_probe() -> dict:
    """轻量稳定性探测：连续 3 秒中等规模训练，观察内存是否泄漏、是否报错。"""
    dev = torch.device("mps")
    model = torch.nn.Sequential(
        torch.nn.Linear(256, 256), torch.nn.ReLU(),
        torch.nn.Linear(256, 256), torch.nn.ReLU(),
        torch.nn.Linear(256, 128),
    ).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
    x = torch.randn(256, 256, device=dev)
    torch.manual_seed(0)
    steps = 0
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < 3.0:
        out = model(x)
        loss = out.square().mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        steps += 1
    torch.mps.synchronize()
    return {
        "steps_3s": steps,
        "steps_per_second": round(steps / 3.0, 1),
        "mps_allocated_mb_after": round(torch.mps.current_allocated_memory() / 1e6, 1),
        "driver_allocated_mb_after": round(torch.mps.driver_allocated_memory() / 1e6, 1),
    }


def main() -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    report = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "system": system_info(),
        "mps_correctness": mps_correctness(),
        "mps_speed_probe": mps_compute_speed_probe(),
        "memory": memory_report(),
        "stability_probe": stress_stability_probe(),
    }
    out = RESULTS_DIR / "env_audit.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    # 控制台摘要
    print(json.dumps(report["system"], ensure_ascii=False, indent=2))
    print(f"MPS 算子全部通过: {report['mps_correctness']['all_ok']}")
    bad = {k: v for k, v in report["mps_correctness"]["checks"].items() if not v.get("ok")}
    if bad:
        print("失败算子:", json.dumps(bad, ensure_ascii=False, indent=2))
    print(f"MPS 速度探测: {report['mps_speed_probe']}")
    print(f"内存: {report['memory']}")
    print(f"稳定性: {report['stability_probe']}")
    print(f"结果已写入: {out}")


if __name__ == "__main__":
    main()
