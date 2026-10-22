"""AI 5.0 向量化对局环境（Python 侧）。

管理 K 个持久化 Node 对局宿主进程（bridge/env_worker.mjs），职责：
- 进程生命周期（启动、异常重启记数、优雅关闭）；
- 决策请求汇集：把多个 worker 的 MLP 决策请求攒成批量交给调用方；
- 对局编排：worker 空闲即派发下一局配置（席位布局 × 种子）；
- 线程模型：每 worker 一个读取线程 + 队列；主线程做批量前向与采样。

协议向量字段为 {b64, len} f32LE base64（bridge/encode.mjs packF32 的对偶实现）。
"""

from __future__ import annotations

import base64
import json
import os
import queue
import signal
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

BRIDGE_DIR = Path(__file__).resolve().parent.parent / "bridge"
WORKER_SCRIPT = BRIDGE_DIR / "env_worker.mjs"


def unpack_f32(field: dict) -> np.ndarray:
    """base64 f32LE → np.float32 数组（packF32 的对偶）。"""
    arr = np.frombuffer(base64.b64decode(field["b64"]), dtype="<f4")
    if "len" in field and arr.size != field["len"]:
        raise ValueError(f"向量长度不符：期望 {field['len']}，实际 {arr.size}")
    return arr


@dataclass
class DecisionRequest:
    """一个 MLP 席位的决策请求。"""
    worker_id: int
    game_id: int
    seat: int
    turn_number: int
    phase: str
    obs: np.ndarray            # [STATE_DIM] f32
    cand_mat: np.ndarray       # [n_candidates, ACTION_DIM] f32
    n_candidates: int
    candidates: list           # 描述符（日志/诊断用）
    enum_stats: dict           # 枚举覆盖率统计（剪枝审计用）


@dataclass
class GameResult:
    """一局终局信息。"""
    worker_id: int
    game_id: int
    status: str                # finished / anomaly
    reason: str | None
    scores: list
    ranks: list | None         # 按名次的席位序
    winner_seat: int | None
    moves: int
    wall_ms: float
    seat_stats: list
    enum_agg: dict
    seats: list                # 本局席位配置（回传自编排器）
    seed: int


@dataclass
class SeatSpec:
    """席位策略配置。kind: mlp / node。"""
    kind: str
    variant: str | None = None  # node 席位：champion / neutral / profile-N / random
    policy_id: str = ""         # mlp 席位：learner / snap-N

    def to_proto(self) -> dict:
        if self.kind == "mlp":
            return {"kind": "mlp"}
        return {"kind": "node", "variant": self.variant or "champion"}

    @staticmethod
    def mlp(policy_id: str) -> "SeatSpec":
        return SeatSpec("mlp", policy_id=policy_id)

    @staticmethod
    def node(variant: str) -> "SeatSpec":
        return SeatSpec("node", variant=variant)


def _pump(proc: subprocess.Popen, out_q: queue.Queue, worker_id: int, error_q: queue.Queue) -> None:
    """读取线程：worker stdout → 共享消息队列。

    必须用 readline 迭代：`for line in proc.stdout` 有预读缓冲，
    会阻塞到缓冲填满才交付行（进程间低吞吐场景的经典陷阱）。
    """
    try:
        while True:
            line = proc.stdout.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                error_q.put({"worker": worker_id, "kind": "json_error", "line": line[:400]})
                continue
            msg["_worker"] = worker_id
            out_q.put(msg)
        out_q.put({"type": "worker_exited", "_worker": worker_id, "code": proc.poll()})
    except Exception as exc:  # 读取线程绝不让解释器挂掉
        error_q.put({"worker": worker_id, "kind": "pump_error", "error": repr(exc)})


class VecEnv:
    """K 个 Century 对局宿主进程的编排器。"""

    def __init__(self, workers: int = 4, max_moves: int = 1200, deadline_ms: int = 60_000,
                 max_candidates: int = 512, seed_salt: int = 0, env_extra: dict | None = None):
        if workers < 1:
            raise ValueError("workers 必须 ≥ 1")
        self.n_workers = workers
        self.max_moves = max_moves
        self.deadline_ms = deadline_ms
        self.max_candidates = max_candidates
        self.seed_salt = seed_salt
        env = {**os.environ, "AI5_WORKER_SEED": str(seed_salt), **(env_extra or {})}
        self.procs: list[subprocess.Popen] = []
        self.error_q: queue.Queue = queue.Queue()
        self.msg_q: queue.Queue = queue.Queue()
        self._threads: list[threading.Thread] = []
        self.worker_busy: list[bool] = [False] * workers
        self.worker_games: list[tuple[int, list] | None] = [None] * workers  # (seed, seats)
        self.restarts = 0
        self.closed = False
        for i in range(workers):
            self._spawn(i, env)

    def _spawn(self, worker_id: int, env: dict) -> None:
        proc = subprocess.Popen(
            ["node", str(WORKER_SCRIPT)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", env=env,
        )
        self.procs.append(proc)
        t = threading.Thread(target=_pump, args=(proc, self.msg_q, worker_id, self.error_q), daemon=True)
        t.start()
        self._threads.append(t)

    # —— 消息收取 ——

    def _handle_worker_message(self, msg: dict) -> DecisionRequest | GameResult | None:
        mtype = msg.get("type")
        worker_id = msg["_worker"]
        if mtype == "decision":
            seed, seats = self.worker_games[worker_id]
            self.worker_busy[worker_id] = True
            return DecisionRequest(
                worker_id=worker_id, game_id=msg["gameId"], seat=msg["seat"],
                turn_number=msg["turnNumber"], phase=msg["phase"],
                obs=unpack_f32(msg["obs"]),
                cand_mat=unpack_f32(msg["candMat"]).reshape(msg["candMat"]["rows"], msg["candMat"]["cols"]),
                n_candidates=msg["candMat"]["rows"],
                candidates=msg["candidates"], enum_stats=msg["enum"],
            )
        if mtype == "terminal":
            seed, seats = self.worker_games[worker_id]
            self.worker_busy[worker_id] = False
            self.worker_games[worker_id] = None
            return GameResult(
                worker_id=worker_id, game_id=msg["gameId"], status=msg["status"],
                reason=msg.get("reason"), scores=msg.get("scores") or [],
                ranks=msg.get("ranks"), winner_seat=msg.get("winnerSeat"),
                moves=msg.get("moves", 0), wall_ms=msg.get("wallMs", 0.0),
                seat_stats=msg.get("seatStats") or [], enum_agg=msg.get("enumAgg") or {},
                seats=seats, seed=seed,
            )
        if mtype == "fatal":
            raise RuntimeError(f"worker {worker_id} fatal：{msg.get('reason')}")
        if mtype == "worker_exited":
            raise RuntimeError(f"worker {worker_id} 意外退出（code={msg.get('code')}）")
        return None

    def drain(self, timeout: float | None = None) -> list:
        """收取全部就绪消息（decision / terminal）。timeout 秒内无消息返回空表。"""
        out = []
        # 先检查 worker 错误。
        while True:
            try:
                err = self.error_q.get_nowait()
                raise RuntimeError(f"worker 错误：{err}")
            except queue.Empty:
                break
        try:
            first = self.msg_q.get(timeout=timeout) if timeout else self.msg_q.get_nowait()
        except queue.Empty:
            return out
        msg = self._handle_worker_message(first)
        if msg is not None:
            out.append(msg)
        while True:
            try:
                msg = self._handle_worker_message(self.msg_q.get_nowait())
            except queue.Empty:
                break
            if msg is not None:
                out.append(msg)
        return out

    def pending_decisions(self) -> int:
        return sum(self.worker_busy)

    # —— 对局派发 ——

    def start_game(self, worker_id: int, game_id: int, seed: int, seats: list) -> None:
        """向指定 worker 派发一局。seed 必须为非负且 < 2^31（引擎安全上限）。"""
        if not (0 <= seed < 2**31):
            raise ValueError(f"seed {seed} 超出引擎安全范围 [0, 2^31)")
        if self.worker_busy[worker_id]:
            raise RuntimeError(f"worker {worker_id} 忙碌，不能派发新局")
        self.worker_games[worker_id] = (seed, seats)
        self.send(worker_id, {
            "type": "game", "gameId": game_id, "seed": seed, "seatCount": len(seats),
            "seats": [s.to_proto() for s in seats],
            "maxMoves": self.max_moves, "deadlineMs": self.deadline_ms,
            "maxCandidates": self.max_candidates,
        })

    def respond(self, worker_id: int, game_id: int, action_index: int) -> None:
        self.send(worker_id, {"type": "action", "gameId": game_id, "index": int(action_index)})

    def send(self, worker_id: int, msg: dict) -> None:
        proc = self.procs[worker_id]
        try:
            proc.stdin.write(json.dumps(msg, separators=(",", ":")) + "\n")
            proc.stdin.flush()
        except BrokenPipeError:
            raise RuntimeError(f"worker {worker_id} 管道已断开")

    # —— 生命周期 ——

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        for i, proc in enumerate(self.procs):
            try:
                self.send(i, {"type": "close"})
            except Exception:
                pass
        for proc in self.procs:
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)

    def rss_mb(self) -> float:
        """全部 worker 的 RSS 合计（MB）；macOS 用 ps，Linux 用 /proc。"""
        pids = [str(p.pid) for p in self.procs if p.poll() is None]
        if not pids:
            return 0.0
        try:
            out = subprocess.run(
                ["ps", "-o", "rss=", "-p", ",".join(pids)],
                capture_output=True, text=True, timeout=5,
            ).stdout
            return sum(float(x) for x in out.split()) / 1024
        except Exception:
            return 0.0
