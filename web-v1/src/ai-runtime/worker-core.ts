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
  PROTOCOL_VERSION, isCompatibleProtocolVersion, validateObservationShape,
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
        superseded.clear();
        return;
      }
      case 'decision': {
        const { requestId, gameStateVersion, payload } = request;
        if (superseded.has(requestId)) {
          superseded.delete(requestId);
          post({ kind: 'cancelled', protocolVersion: PROTOCOL_VERSION, requestId });
          return;
        }
        if (request.gameStateVersion !== gameStateVersion) {
          // 不可达守卫（类型完整性）；无害忽略。
          sendError(requestId, 'gameStateVersion 字段不一致', 'protocol');
          return;
        }
        try {
          // 结构防火墙：观察载荷必须是白名单公开字段（拒绝整份 Game 等越权载荷）。
          validateObservationShape(payload?.observation);
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
