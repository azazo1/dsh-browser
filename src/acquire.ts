/**
 * 浏览器驱动权的申请.
 *
 * 浏览器平面是独占的: 分发给扩展的持久 profile 只有一个, 扩展内部也只维持一个"当前绑定
 * 标签页". 两个会话同时驱动会互相踩, 所以插件把它做成一份**可申请的驱动权**.
 *
 * 申请只发生在两个显式工具上: `browser_open` (可顺便打开页面) 与 `browser_acquire`
 * (只取驱动权). 其它工具在未取得驱动权时直接报错并提示先调它们, **不弹审批** —— 否则任何
 * 一次读页面都会突然冒出授权窗口. 只读工具 (`browser_status`, `browser_tabs`,
 * `browser_release`) 完全不需要驱动权.
 *
 * 单独一个模块, 是因为这段判定既要被插件装配用, 也要能被直接测试: 决定"第二个会话怎么才
 * 能用上"的逻辑如果只在测试里另抄一份, 那测的就是副本而不是真行为.
 *
 * 申请走 harness 标准的审批通道 (同一个应答者, 同样在会话日志里留下 `approval/asked` 与
 * `approval/decided` 审计对), 所以它遵守会话的审批策略, 也能被 `auto-review` 一类插件
 * 自动应答.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BrowserRuntime } from './runtime.js'
import type { Config } from './config.js'
import type { SetupStatus } from './setup.js'

/**
 * 会向用户发起审批的两个入口.
 *
 * 只有它们能"取得驱动权"; 其它工具未持有时直接报错, 不弹审批. 关掉 askOnAcquire 时它们
 * 也退化为静默取得.
 */
export const ACQUIRE_TOOLS: ReadonlySet<string> = new Set([
  'browser_open',
  'browser_acquire',
])

/**
 * 需要驱动权的工具.
 *
 * 只读工具刻意不在其中: `browser_status` 不碰浏览器; `browser_tabs` 只列标签页;
 * `browser_release` 只是放弃权利. 它们不需要申请 —— 这也让第二个会话在申请之前就能看清
 * "现在归谁", 而不是先撞一次拒绝.
 */
export const BROWSER_TOOLS: ReadonlySet<string> = new Set([
  'browser_open',
  'browser_acquire',
  'browser_select_tab',
  'browser_close_tab',
  'browser_snapshot',
  'browser_text',
  'browser_click',
  'browser_fill',
  'browser_press_key',
  'browser_scroll',
  'browser_navigate',
  'browser_wait',
  'browser_query',
  'browser_hover',
  'browser_upload',
  'browser_screenshot',
  'browser_evaluate',
])

/**
 * 判断这次调用是否需要向用户申请.
 *
 * 只有两个"获取驱动权"的入口会问: `browser_open` 与 `browser_acquire`. 其它工具在没有
 * 驱动权时不是"申请", 而是直接报错让调用方先去取权 —— 否则任何一次读页面都会突然弹出
 * 授权窗口.
 *
 * 关掉 askOnAcquire 时一律不问: 直接静默取得 (见 requestBrowserAccess).
 *
 * @param input 判定输入.
 * @returns 是否需要征求同意.
 */
export function needsBrowserConsent(input: {
  toolName: string
  holdsBrowser: boolean
  enabled: boolean
}): boolean {
  if (!input.enabled) return false
  if (input.holdsBrowser) return false
  return ACQUIRE_TOOLS.has(input.toolName)
}

/**
 * 给审批弹窗写一句用户能读懂的理由.
 *
 * 自己生成而不是要求模型传理由: 每个工具都要带一个理由参数太重, 而且这里真正需要用户
 * 判断的信息 (现在归谁) 只有插件知道. 工具若自带 `justification` 参数就一并带上, 那是
 * 模型对"为什么需要浏览器"的说明.
 *
 * @param toolName 工具名.
 * @param args 工具参数.
 * @param occupantId 当前持有浏览器的会话 id; 无人为 null.
 * @returns 审批理由.
 */
export function acquireReason(toolName: string, args: unknown, occupantId: string | null): string {
  const stated = args !== null && typeof args === 'object' && 'justification' in args
    ? (args as { justification?: unknown }).justification
    : undefined
  const because = typeof stated === 'string' && stated.trim() !== '' ? stated.trim() : ''
  // 实现上同一时刻只能有一个会话驱动浏览器, 但弹窗里不必讲 profile / 绑定标签页.
  // justification 是模型写给用户看的那句话, 放在最后, 后面不再追加任何内容.
  const head = occupantId === null
    ? `这个会话要用浏览器 (${toolName}).`
    : `这个会话要用浏览器 (${toolName}). 现在由会话 ${occupantId} 占用, 同意后会转交过来.`
  return because === '' ? head : `${head} ${because}`
}

/** 申请的结果. */
export type AcquireDecision = { kind: 'allow' } | { kind: 'deny', reason: string }

/** 申请所需的输入. */
export interface AcquireInput {
  /** 浏览器运行时. */
  runtime: BrowserRuntime
  /** 插件配置; 只用到 askOnAcquire. */
  config: Config
  /** 审批服务, 缺失表示当前部署没有审批通道. */
  approval: ApprovalLike | undefined
  /** 发起调用的会话. */
  agent: Agent
  /** 工具名. */
  toolName: string
  /** 调用 id, 审批审计要用. */
  callId: string
  /** 工具参数. */
  args: unknown
  /** 取消信号. */
  signal: AbortSignal
  /** 当前的配置就绪状态; 不就绪时不会征求授权, 而是返回配置说明. */
  setup: SetupStatus
}

/**
 * 审批服务的最小接口.
 *
 * 自行声明而不是从包里导入类型: 本插件对审批只用到这一个方法, 而导入那个包会给产物加一条
 * 未必存在的运行时依赖. 形状按官方 `ApprovalService.request` 的真实签名写.
 */
export interface ApprovalLike {
  /**
   * 请求一次审批.
   *
   * @param request 请求内容.
   * @returns 结果; `allowed-once` 是唯一的允许.
   */
  request(request: {
    agent: Agent
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/**
 * 为一个会话申请浏览器驱动权.
 *
 * 这里是"申请"的全部语义: 先问用户, **拿到答复之后**才决定是否授予. 之所以直接调审批
 * 服务而不是返回一个 ask 决策, 正是因为需要知道答复 —— 只把决定转交出去的话, 钩子看不到
 * 结果, 也就没法做到"先问后给".
 *
 * askOnAcquire 关掉时退回"自动放行": 不问, 但仍然要真的把驱动权交给发起的会话 (见下).
 *
 * @param input 申请输入.
 * @returns 允许或带原因的拒绝.
 */
export async function requestBrowserAccess(input: AcquireInput): Promise<AcquireDecision> {
  const holds = input.runtime.holdsBrowser(input.agent)
  const browserTool = BROWSER_TOOLS.has(input.toolName)

  // 只读工具 (status / tabs / release) 与无关工具: 不需要驱动权, 直接放行.
  if (!browserTool) return { kind: 'allow' }
  if (holds) return { kind: 'allow' }

  const enabled = input.config.askOnAcquire.get()
  if (!enabled) {
    // 静默取得: 不问用户, 但驱动权必须真的交过去, 否则工具执行时会被拒.
    if (!input.setup.ready) return { kind: 'deny', reason: input.setup.guide }
    input.runtime.grant(input.agent)
    return { kind: 'allow' }
  }

  // 没有驱动权, 而这次不是"获取驱动权"的入口: 直接拒绝, 不弹审批.
  if (!ACQUIRE_TOOLS.has(input.toolName)) {
    return {
      kind: 'deny',
      reason: '本会话还没有浏览器驱动权. 请先调用 browser_acquire (只取得驱动权) '
        + '或 browser_open (可顺便打开页面, 必要时把浏览器启动起来), 之后再调用本工具.',
    }
  }

  // 先确认"有一条能真正用上的路", 再决定要不要问用户.
  //
  // 次序很重要: 没配好就问, 用户同意之后仍然什么都做不了, 而且他完全不知道缺什么 —— 那个
  // 弹窗纯粹是一次打扰. 所以这种情况直接返回配置说明, 请模型讲给用户听.
  if (!input.setup.ready) {
    return { kind: 'deny', reason: input.setup.guide }
  }

  if (input.approval === undefined) {
    // 没有人能同意, 所以不放行. "静默取得浏览器"正是要避免的行为, 放行会让它在无人值守
    // 环境里悄悄发生. 想在这种环境里用, 就显式关掉 askOnAcquire.
    return {
      kind: 'deny',
      reason: '本会话还没有取得浏览器, 而当前部署没有可用的审批通道, 无法征求用户同意. '
        + '请在插件配置页确认审批可用, 或显式关闭 askOnAcquire (那会退回静默自动取得).',
    }
  }

  const outcome = await input.approval.request({
    agent: input.agent,
    toolName: input.toolName,
    callId: input.callId,
    reason: acquireReason(input.toolName, input.args, input.runtime.grantedId),
    signal: input.signal,
  })

  if (outcome !== 'allowed-once') {
    const because = outcome === 'rejected'
      ? '用户拒绝了这次申请'
      : outcome === 'cancelled'
        ? '申请被取消'
        : '没有可用的审批通道'
    return {
      kind: 'deny',
      reason: `${because}, 因此本会话没有取得浏览器. `
        + '如果确实要用, 请重新发起一次调用再申请; '
        + '用户也可以让那个持有浏览器的会话调用 browser_release 主动让出.',
    }
  }

  // 用户同意了: 这时才真正把驱动权交过来. 若原本在别人手上, 一并收回 —— 那个会话之后的
  // 调用会重新申请, 于是"归谁"始终由用户决定.
  input.runtime.grant(input.agent)
  return { kind: 'allow' }
}

/**
 * 用户在会话 Tab 里点了"获取": 这本身就是同意, 不再走审批弹窗.
 *
 * 仍要检查就绪: 没配好时授予一份用不了的驱动权, 只会让界面看起来"已经拿到"而工具全失败.
 *
 * @param input 授予输入.
 * @returns 允许或带原因的拒绝.
 */
export function grantFromUserClick(input: {
  runtime: BrowserRuntime
  agent: Agent
  setup: SetupStatus
}): AcquireDecision {
  if (input.runtime.holdsBrowser(input.agent)) return { kind: 'allow' }
  if (!input.setup.ready) return { kind: 'deny', reason: input.setup.guide }
  input.runtime.grant(input.agent)
  return { kind: 'allow' }
}
