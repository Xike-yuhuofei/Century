/** Worker 消息核（环境无关）：协议分派 + 决策执行 + 顺序处理 + 过期请求淘汰。
 *
 * 本模块不引用任何宿主环境全局（self/worker_threads/DOM），只通过构造时注入的
 * post 回调发送响应消息——同一份编译产物同时服务：
 * - 浏览器 DedicatedWorkerGlobalScope（worker.ts 薄壳绑定 self）；
 * - Node worker_threads（测试桥接 parentPort）——保证测试与浏览器同核。
 *
 * 生命周期语义：
 * - init：协议主版本握手；不一致回 error(fatal)。
 * - decision：顺序处理（单线程 Worker 的消息循环天然排队）。处理时先查
 *   superseded 集合——已被 client 取消/替代的请求直接回 cancelled，不执行决策。
 * - cancel：把请求标记为 superseded。注意：正在执行中的决策无法被消息中断
 *   （decide 同步占满 Worker 事件循环，且任务书禁止修改搜索内部实现来插入
 *   检查点）；对"执行中"任务的真取消由 client 看门狗 terminate 实现。
 * - reset：换局信号——清空 superseded 标记之外的全部暂态（当前实现仅缓存
 *   planner 实例，无跨局可污染状态；reset 语义上隔绝旧局残留）。
 */

import {
  PROTOCOL_VERSION, isCompatibleProtocolVersion, validateDecisionPayload,
  type AIWorkerRequest, type AIWorkerResponse,
} from './protocol.js';
import { decideFromObservation, DecisionCoreError } from './decision-core.js';

export type AIWorkerCore = {
  /** 处理一条 client → worker 消息（宿主负责投递）。 */
  handleMessage(raw: unknown): void;
  /** 注入的发送函数（测试可替换）。 */
  readonly post: (response: AIWorkerResponse) => void;
};

export function createAIWorkerCore(post: (response: AIWorkerResponse) => void): AIWorkerCore {
  /** 已被取消/替代、尚未开始处理的请求 id 集合。 */
  const superseded = new Set<string>();
  /** 已接受决策的最大 gameStateVersion 水位（P1-1：过期状态版本的真实防线）——
   * 迟到的旧版本决策请求（乱序投递/客户端缺陷）直接回 cancelled，绝不执行。 */
  let versionWatermark = -1;
  let ready = false;

  const sendError = (requestId: string | null, message: string, category: 'protocol' | 'decision' | 'fatal') => {
    post({ kind: 'error', protocolVersion: PROTOCOL_VERSION, requestId, message, category });
  };

  const handleMessage = (raw: unknown): void => {
    let request: AIWorkerRequest;
    try {
      request = raw as AIWorkerRequest;
      if (!request || typeof request !== 'object' || typeof (request as { kind?: unknown }).kind !== 'string') {
        throw new Error('消息缺少 kind 字段');
      }
      if (!isCompatibleProtocolVersion(request.protocolVersion)) {
        throw new DecisionCoreError('protocol', `协议主版本不兼容：期望 ${PROTOCOL_VERSION.split('.')[0]}.x，收到 ${request.protocolVersion}`);
      }
    } catch (error) {
      sendError(null, error instanceof Error ? error.message : String(error), 'protocol');
      return;
    }

    switch (request.kind) {
      case 'init': {
        if (ready) { post({ kind: 'ready', protocolVersion: PROTOCOL_VERSION }); return; }
        // 预热：强制加载决策核心依赖图（模块级 import 已完成；此处可做轻量自检）。
        ready = true;
        post({ kind: 'ready', protocolVersion: PROTOCOL_VERSION });
        return;
      }
      case 'cancel': {
        superseded.add(request.requestId);
        return;
      }
      case 'reset': {
        // 换局信号：清空取消标记 + 重置状态版本水位（新对局可能重新从低版本计数）。
        superseded.clear();
        versionWatermark = -1;
        return;
      }
      case 'decision': {
        const { requestId, gameStateVersion, payload } = request;
        if (superseded.has(requestId)) {
          superseded.delete(requestId);
          post({ kind: 'cancelled', protocolVersion: PROTOCOL_VERSION, requestId });
          return;
        }
        // P1-1 整改：v1.0 此处是与自身比较的无效不变量（恒 false 死代码）。
        // 替换为真实检查：
        // ① 类型/范围校验（协议层）；② 过期状态版本水位（迟到旧请求拒绝执行）。
        if (typeof gameStateVersion !== 'number' || !Number.isSafeInteger(gameStateVersion) || gameStateVersion < 0) {
          sendError(requestId, `gameStateVersion 必须为非负安全整数，实际：${JSON.stringify(gameStateVersion)}`, 'protocol');
          return;
        }
        if (gameStateVersion < versionWatermark) {
          post({ kind: 'cancelled', protocolVersion: PROTOCOL_VERSION, requestId });
          return;
        }
        versionWatermark = Math.max(versionWatermark, gameStateVersion);
        try {
          // 结构防火墙（v1.1 递归）：观察/版本描述符/预算/种子的严格 schema 校验
          //（拒绝整份 Game 等越权载荷与任意嵌套层级的隐藏牌库字段）。
          validateDecisionPayload(payload);
        } catch (error) {
          sendError(requestId, error instanceof Error ? error.message : String(error), 'protocol');
          return;
        }
        let response: AIWorkerResponse;
        try {
          const { action, diagnostics } = decideFromObservation(payload);
          response = {
            kind: 'decision',
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            gameStateVersion,
            diagnostics: { ...diagnostics, protocolVersion: PROTOCOL_VERSION, requestId, gameStateVersion },
          };
        } catch (error) {
          const category = error instanceof DecisionCoreError ? error.category : 'decision';
          response = {
            kind: 'error', protocolVersion: PROTOCOL_VERSION, requestId,
            message: error instanceof Error ? error.message : String(error), category,
          };
        }
        // 发送前再查一次 superseded（决策期间收到 cancel 的情形）：
        // 已取消的决策结果永不投递——client 端不会拿到可提交的过期行动。
        if (superseded.has(requestId)) {
          superseded.delete(requestId);
          post({ kind: 'cancelled', protocolVersion: PROTOCOL_VERSION, requestId });
          return;
        }
        post(response);
        return;
      }
      default: {
        sendError(null, `未知请求类型：${JSON.stringify((request as { kind?: unknown }).kind)}`, 'protocol');
      }
    }
  };

  return { handleMessage, post };
}
