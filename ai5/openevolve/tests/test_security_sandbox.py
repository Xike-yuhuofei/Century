"""AI5 OpenEvolve 安全边界测试（P0 安全整改验收）：Seatbelt 全链路覆盖。

验证目标（全部在真实 sandbox-exec 下执行，仅 macOS）：
1. 静态检查/组装/编译（本次整改补沙箱的三个前置步骤）能处理合法候选；
2. 恶意样例被拒（静态禁构造路径必须真正可达——样例带 EVOLVE-BLOCK 标记）；
3. 运行时恶意行为（死循环）被超时淘汰；
4. 沙箱属性本身：读真实主目录被拒、写工作区外被拒、联网被拒。

运行：~/century-ai5-env/bin/python ai5/openevolve/tests/test_security_sandbox.py -v
（Linux 上 sandbox-exec 不存在 → 自动 skip，不得以 Linux 通过冒充 Seatbelt 验收。）
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from ai5.openevolve import century_evaluator  # noqa: E402
from ai5.openevolve.century_evaluator import (  # noqa: E402
    _ensure_dirs, _render_sandbox_profile, _run, _run_static, _stage_impl,
)

MALICIOUS_DIR = REPO / "ai5" / "openevolve" / "experiments" / "malicious"
BENIGN_FN = REPO / "ai5" / "openevolve" / "results" / "evaluations" / "66f6a296aa72" / "function.ts"


def with_evolve_markers(fn_text: str) -> str:
    return f"/* EVOLVE-BLOCK-START */\n{fn_text.strip()}\n/* EVOLVE-BLOCK-END */\n"


@unittest.skipIf(sys.platform != "darwin", "Seatbelt（sandbox-exec）仅 macOS；Linux 结果不得冒充 Seatbelt 验收")
class TestSandboxSecurity(unittest.TestCase):
    """全部用例使用隔离的临时 WORK_ROOT——防止与并行 OpenEvolve 会话共享工作区
    互相污染（实测教训：共享 work root 曾让并行进程消费测试遗留的候选文件，
    并把评估归档写进对方结果树）。"""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        work_root = Path(cls._tmp.name) / "work"
        work_root.mkdir(parents=True)
        cls._old = {k: getattr(century_evaluator, k) for k in
                    ("WORK_ROOT", "CACHE_ROOT", "RESULTS_ROOT", "SANDBOX_ENV")}
        century_evaluator.WORK_ROOT = work_root
        century_evaluator.CACHE_ROOT = work_root / "cache"
        century_evaluator.RESULTS_ROOT = work_root / "evaluations"
        century_evaluator.SANDBOX_ENV = {
            **century_evaluator.SANDBOX_ENV,
            "HOME": str(work_root / "home"),
            "TMPDIR": str(work_root / "tmp"),
        }
        _ensure_dirs()
        cls.profile = _render_sandbox_profile()

    @classmethod
    def tearDownClass(cls):
        for k, v in cls._old.items():
            setattr(century_evaluator, k, v)
        cls._tmp.cleanup()

    def _static(self, src: str):
        with tempfile.NamedTemporaryFile("w", suffix=".ts", delete=False) as fh:
            fh.write(src)
            path = fh.name
        try:
            ok, out_json, proc = _run_static(path, self.profile)
            try:
                detail = json.loads(out_json.read_text())
            except Exception:
                detail = {"stderr": proc.stderr[-400:], "stdout": proc.stdout[-400:]}
            return ok, detail
        finally:
            Path(path).unlink(missing_ok=True)

    def test_all_malicious_samples_rejected_by_static_check(self):
        """静态禁构造（import/eval/fetch/process/随机数/时钟/文件系统/牌库）必须可达。"""
        for sample in sorted(MALICIOUS_DIR.glob("m*.ts")):
            if sample.name == "m05_infinite_loop.ts":
                continue  # 死循环无静态特征 → 专测运行时超时
            ok, detail = self._static(sample.read_text())
            self.assertFalse(ok, f"{sample.name} 必须被静态检查拒绝（detail={detail}）")
            reason = detail.get("reason") or detail.get("stderr") or detail.get("stdout")
            self.assertTrue(reason, f"{sample.name} 必须给出拒绝原因（detail={detail}）")

    def test_benign_evolved_candidate_passes_sandboxed_stage1(self):
        """合法演化候选在全部沙箱化的 stage1（静态→组装→编译→探针）上必须通过。"""
        src = with_evolve_markers(BENIGN_FN.read_text())
        with tempfile.NamedTemporaryFile("w", suffix=".ts", delete=False) as fh:
            fh.write(src)
            path = fh.name
        try:
            metrics = _stage_impl(path, 1)
        finally:
            Path(path).unlink(missing_ok=True)
        self.assertEqual(metrics.get("stage_passed"), 1.0,
                         f"合法候选不得被沙箱化管线误杀：{metrics}")
        self.assertEqual(metrics.get("static_ok"), 1.0)
        self.assertEqual(metrics.get("compile_ok"), 1.0)
        self.assertEqual(metrics.get("probe_ok"), 1.0)

    def test_infinite_loop_killed_by_probe_timeout(self):
        """运行时恶意行为（死循环）由超时淘汰：rc=-9 → 拒绝。"""
        # m05 样例自带 EVOLVE-BLOCK 标记，原样写入（不可再包裹，双重标记会被静态检查拒绝）。
        with tempfile.NamedTemporaryFile("w", suffix=".ts", delete=False) as fh:
            fh.write((MALICIOUS_DIR / "m05_infinite_loop.ts").read_text())
            path = fh.name
        try:
            # 直接以 10s 预算运行探针（_stage_impl 的 120s 对测试过长；淘汰语义一致）。
            ok, static_json, proc = _run_static(path, self.profile)
            self.assertTrue(ok, f"死循环样例应先通过静态检查（无静态特征）：{static_json.read_text()[:200]}")
            fn_text_file = Path(str(static_json).replace(".json", ".fn.ts"))
            # 组装 + 编译 + 探针全链路，探针以 10s 超时运行（死循环必须被杀）。
            workdir = century_evaluator.CACHE_ROOT / "probe-timeout-test"
            asm = _run(["/usr/bin/sandbox-exec", "-f", str(self.profile), "node",
                        str(REPO / "ai5" / "openevolve" / "node" / "assemble_candidate.mjs"),
                        "--program", str(fn_text_file), "--out", str(workdir)], 60, "assemble")
            self.assertEqual(asm.returncode, 0, asm.stderr[-300:])
            tsc = _run(["/usr/bin/sandbox-exec", "-f", str(self.profile),
                        "node", str(REPO / "web-v1/node_modules/typescript/bin/tsc"),
                        "-p", str(workdir / "tsconfig.json")], 120, "tsc", cwd=workdir)
            self.assertEqual(tsc.returncode, 0, tsc.stderr[-300:])
            probe = _run(["/usr/bin/sandbox-exec", "-f", str(self.profile), "node",
                          str(REPO / "ai5" / "openevolve" / "node" / "probe.mjs"),
                          "--candidate", str(workdir / "dist/js/ai/evaluator.js"),
                          "--out", str(century_evaluator.WORK_ROOT / "probe-test.json")],
                         10, "probe")  # 10s 超时：死循环必须被杀
            self.assertEqual(probe.returncode, -9, f"死循环探针必须超时淘汰（rc={probe.returncode}）")
            self.assertIn("TIMEOUT", probe.stderr)
        finally:
            Path(path).unlink(missing_ok=True)

    def test_sandbox_blocks_home_read_and_out_of_workroot_write(self):
        """沙箱属性直测：读真实主目录内容 / 写 WORKROOT 外都必须失败（EPERM）。

        HOME 拒绝语义是 file-read-data（内容）：在 HOME 下创建真实探针文件，
        读其内容必须被拒（目录/元数据语义差异不进入判定）。"""
        real_home = str(Path.home())
        repo_root = str(REPO)
        probe_file = Path(real_home) / "ai5-sandbox-home-read-probe.txt"
        probe_file.write_text("probe")
        probe_src = """
const fs = require('node:fs');
const results = {};
try { fs.readFileSync(process.argv[2]); results.homeRead = 'ALLOWED'; }
catch (e) { results.homeRead = e.code === 'EPERM' ? 'DENIED' : 'ALLOWED(' + e.code + ')'; }
try { fs.writeFileSync(process.argv[3] + '/ai5-sandbox-escape-test.txt', 'x'); results.ooWrite = 'ALLOWED'; }
catch (e) { results.ooWrite = e.code === 'EPERM' ? 'DENIED' : 'DENIED(' + e.code + ')'; }
process.stdout.write(JSON.stringify(results));
"""
        with tempfile.NamedTemporaryFile("w", suffix=".cjs", delete=False) as fh:
            fh.write(probe_src)
            path = fh.name
        try:
            proc = _run(["/usr/bin/sandbox-exec", "-f", str(self.profile), "node", path,
                         probe_file, repo_root], 15, "sandbox-property")
            self.assertEqual(proc.returncode, 0, proc.stderr[-300:])
            results = json.loads(proc.stdout.strip().splitlines()[-1])
            self.assertEqual(results["homeRead"], "DENIED",
                             f"沙箱必须拒绝读取真实主目录内容：{results}")
            self.assertEqual(results["ooWrite"], "DENIED",
                             f"沙箱必须拒绝写 WORKROOT 外路径（仓库根）：{results}")
        finally:
            Path(path).unlink(missing_ok=True)
            probe_file.unlink(missing_ok=True)
            Path(REPO / "ai5-sandbox-escape-test.txt").unlink(missing_ok=True)

    def test_workroot_write_and_repo_read_allowed(self):
        """沙箱白名单语义：写 WORKROOT、读仓库脚本必须被允许（pipeline 前提）。

        Runner 上 static_check 连拒绝分支的 out 落盘都失败时，用本测试区分
        「WORKROOT 写被拒」与「仓库读被拒」两类环境问题。"""
        probe_src = """
const fs = require('node:fs');
const results = {};
try {
  fs.writeFileSync(process.argv[2] + '/sandbox-write-ok.txt', 'ok');
  results.workrootWrite = 'ALLOWED';
} catch (e) { results.workrootWrite = 'DENIED(' + e.code + ')'; }
try {
  const s = fs.readFileSync(process.argv[3], 'utf8');
  results.repoRead = s.length > 0 ? 'ALLOWED' : 'EMPTY';
} catch (e) { results.repoRead = 'DENIED(' + e.code + ')'; }
process.stdout.write(JSON.stringify(results));
"""
        with tempfile.NamedTemporaryFile("w", suffix=".cjs", delete=False) as fh:
            fh.write(probe_src)
            path = fh.name
        try:
            proc = _run(["/usr/bin/sandbox-exec", "-f", str(self.profile), "node", path,
                         str(century_evaluator.WORK_ROOT),
                         str(REPO / "ai5" / "openevolve" / "node" / "static_check.mjs")],
                        15, "sandbox-allow")
            self.assertEqual(proc.returncode, 0, proc.stderr[-400:])
            results = json.loads(proc.stdout.strip().splitlines()[-1])
            self.assertEqual(results["workrootWrite"], "ALLOWED", f"WORKROOT 写必须放行：{results}")
            self.assertEqual(results["repoRead"], "ALLOWED", f"仓库脚本读必须放行：{results}")
        finally:
            Path(path).unlink(missing_ok=True)
            (Path(century_evaluator.WORK_ROOT) / "sandbox-write-ok.txt").unlink(missing_ok=True)

    def test_sandbox_blocks_network(self):
        """联网必须失败：socket connect 被 Seatbelt 拒绝返回 EPERM（与
        ECONNREFUSED/超时等网络语义错误可区分，判定无歧义）。"""
        probe_src = """
const net = require('node:net');
const sock = net.connect({ host: '1.1.1.1', port: 80, timeout: 5000 });
sock.on('connect', () => {
  process.stdout.write(JSON.stringify({ net: 'ALLOWED' }));
  process.exit(0);
});
sock.on('error', (e) => {
  const denied = e.code === 'EPERM';
  process.stdout.write(JSON.stringify({ net: denied ? 'DENIED' : 'AMBIGUOUS(' + e.code + ')' }));
  process.exit(0);
});
"""
        with tempfile.NamedTemporaryFile("w", suffix=".cjs", delete=False) as fh:
            fh.write(probe_src)
            path = fh.name
        try:
            proc = _run(["/usr/bin/sandbox-exec", "-f", str(self.profile), "node", path],
                        15, "sandbox-network")
            self.assertEqual(proc.returncode, 0, proc.stderr[-300:])
            results = json.loads(proc.stdout.strip().splitlines()[-1])
            self.assertEqual(results["net"], "DENIED", f"沙箱必须拒绝联网（EPERM）：{results}")
        finally:
            Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
