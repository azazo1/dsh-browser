/**
 * 浏览器驱动权的申请与让出.
 *
 * 这块逻辑决定"第二个会话怎么才能用上浏览器", 所以不能只看代码就下结论。这里直接驱动
 * **真实的申请逻辑** (`src/acquire.ts`) 与真实运行时, 把几条关键行为钉住:
 *
 *   1. 会话第一次要占用浏览器时, 会走一次审批 (而不是静默取得);
 *   2. 用户同意后, 该会话才真正拿到驱动权;
 *   3. 用户拒绝后, 工具被拒, 而且**不会**拿到驱动权;
 *   4. 已持有驱动权的会话再调用, 不再重复询问;
 *   5. 另一个会话申请并获准后, 驱动权转移过去, 且理由里说明原本归谁;
 *   6. 会话作用域被回收时驱动权自动回到无人持有;
 *   7. `browser_release` 能主动交出, 之后别的会话可以取得;
 *   8. 没有审批通道时是拒绝, 而不是静默放行;
 *   9. 只有 `askOnAcquire` 关掉才回到静默取得;
 *  10. `browser_status` 不申请 (它不碰浏览器), 所以第二个会话能先看清"现在归谁".
 *
 * 测试与插件共用同一份申请逻辑, 而不是在这里另抄一份 —— 否则测出来的是副本的行为。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BROWSER_TOOLS, acquireReason, needsBrowserConsent, requestBrowserAccess } from '../src/acquire.ts'
import { Config } from '../src/config.ts'
import { BrowserRuntime } from '../src/runtime.ts'

/** 一次审批请求里我们关心的部分. */
interface AskRecord {
  agentId: string
  toolName: string
  reason: string | undefined
}

/** 审批的结果词汇. */
type Outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * 造一个带作用域的假会话.
 *
 * `ctx.effect` 是运行时用来在会话结束时放弃驱动权的钩子, 所以桩必须真的实现它, 否则
 * "会话结束自动释放"这条就测不到。
 *
 * @param id 会话 id.
 * @returns 假会话与它的作用域回收入口.
 */
function makeAgent(id: string): { agent: Agent, disposeScope: () => Promise<void> } {
  const cleanups: (() => void | Promise<void>)[] = []
  const agent = {
    id,
    status: 'idle',
    ctx: {
      /**
       * 登记随作用域回收执行的清理函数.
       * @param callback 返回清理函数.
       * @param _name 名称.
       * @returns 触发清理的函数.
       */
      effect: (callback: () => () => void | Promise<void>, _name: string) => {
        const cleanup = callback()
        cleanups.push(cleanup)
        return () => { void cleanup() }
      },
      on: () => () => {},
    },
  } as unknown as Agent
  return {
    agent,
    disposeScope: async () => { for (const cleanup of cleanups) await cleanup() },
  }
}

/**
 * 造一个可编程的审批应答者.
 *
 * @param initial 初始答复.
 * @returns 应答者桩与它收到的申请记录.
 */
function makeApproval(initial: Outcome): {
  asks: AskRecord[]
  setAnswer: (next: Outcome) => void
  service: { request: (request: { agent: Agent, toolName: string, reason?: string }) => Promise<Outcome> }
} {
  let answer = initial
  const asks: AskRecord[] = []
  return {
    asks,
    setAnswer: (next) => { answer = next },
    service: {
      /**
       * 记录这次申请并按当前设置答复.
       * @param request 审批请求.
       * @returns 当前答复.
       */
      request: async (request) => {
        asks.push({ agentId: request.agent.id, toolName: request.toolName, reason: request.reason })
        return answer
      },
    },
  }
}

/**
 * 装配一个真实的运行时, 并用真实的申请逻辑驱动它.
 *
 * @param approval 审批服务桩, undefined 表示部署里没有审批通道.
 * @param askOnAcquire askOnAcquire 配置值.
 * @returns 运行时与申请入口.
 */
function makeHarness(approval: unknown, askOnAcquire = true): {
  runtime: BrowserRuntime
  request: (agent: Agent, toolName: string, args?: unknown) => Promise<{ kind: string, reason?: string }>
} {
  const ctx = new Context() as Context & Record<string, unknown>
  ;(ctx as unknown as { provide: (name: string, value: unknown) => void }).provide('webServer', { port: 54_213 })
  const config = Config({ askOnAcquire })
  const bridge = { token: 'tok', call: async () => undefined, connectionState: { connected: false } }
  const runtime = new BrowserRuntime(ctx, config, bridge as never)
  const request = async (agent: Agent, toolName: string, args: unknown = {}) => requestBrowserAccess({
    runtime,
    config,
    approval: approval as never,
    agent,
    toolName,
    callId: 'call-test',
    args,
    signal: new AbortController().signal,
  })
  return { runtime, request }
}

describe('浏览器驱动权的申请与让出', () => {
  it('会话第一次要占用浏览器时, 会走一次审批', async () => {
    const approval = makeApproval('allowed-once')
    const { request } = makeHarness(approval.service)
    const { agent } = makeAgent('session-a')

    const result = await request(agent, 'browser_snapshot')
    expect(result.kind).toBe('allow')
    // 关键: 静默自动取得是不允许的, 必须真的问过用户.
    expect(approval.asks).toHaveLength(1)
    expect(approval.asks[0]?.toolName).toBe('browser_snapshot')
  })

  it('用户同意后该会话才拿到驱动权', async () => {
    const approval = makeApproval('allowed-once')
    const { request, runtime } = makeHarness(approval.service)
    const { agent } = makeAgent('session-a')

    expect(runtime.holdsBrowser(agent)).toBe(false)
    await request(agent, 'browser_text')
    expect(runtime.holdsBrowser(agent)).toBe(true)
    expect(runtime.grantedId).toBe('session-a')
  })

  it('用户拒绝时工具被拒, 而且拿不到驱动权', async () => {
    const approval = makeApproval('rejected')
    const { request, runtime } = makeHarness(approval.service)
    const { agent } = makeAgent('session-a')

    const result = await request(agent, 'browser_click')
    expect(result.kind).toBe('deny')
    expect(runtime.holdsBrowser(agent)).toBe(false)
    expect(runtime.grantedId).toBeNull()
  })

  it('已持有驱动权的会话再次调用不再询问', async () => {
    const approval = makeApproval('allowed-once')
    const { request } = makeHarness(approval.service)
    const { agent } = makeAgent('session-a')

    await request(agent, 'browser_open')
    // 同一轮里连续操作是常态, 每次都问会把用户烦死.
    await request(agent, 'browser_snapshot')
    await request(agent, 'browser_click')
    await request(agent, 'browser_text')
    expect(approval.asks).toHaveLength(1)
  })

  it('另一个会话申请并获准后, 驱动权转移过去', async () => {
    const approval = makeApproval('allowed-once')
    const { request, runtime } = makeHarness(approval.service)
    const a = makeAgent('session-a')
    const b = makeAgent('session-b')

    await request(a.agent, 'browser_snapshot')
    expect(runtime.grantedId).toBe('session-a')

    const result = await request(b.agent, 'browser_snapshot')
    expect(result.kind).toBe('allow')
    expect(runtime.grantedId).toBe('session-b')
    expect(runtime.holdsBrowser(a.agent)).toBe(false)
    // 第二次申请的理由里必须说明原本归谁, 否则用户没有判断依据.
    expect(approval.asks[1]?.reason).toContain('session-a')
  })

  it('会话结束 (作用域被回收) 时驱动权自动回到无人持有', async () => {
    const approval = makeApproval('allowed-once')
    const { request, runtime } = makeHarness(approval.service)
    const a = makeAgent('session-a')

    await request(a.agent, 'browser_open')
    expect(runtime.grantedId).toBe('session-a')

    await a.disposeScope()
    // 不释放的话, 一个已经消失的会话会永远占着, 后面谁也用不了.
    expect(runtime.grantedId).toBeNull()
  })

  it('browser_release 主动交出后, 别的会话可以取得', async () => {
    const approval = makeApproval('allowed-once')
    const { request, runtime } = makeHarness(approval.service)
    const a = makeAgent('session-a')
    const b = makeAgent('session-b')

    await request(a.agent, 'browser_open')
    expect(runtime.release(a.agent)).toBe(true)
    expect(runtime.grantedId).toBeNull()
    // 不是持有者时再释放是空操作, 不该被当成"释放成功".
    expect(runtime.release(a.agent)).toBe(false)

    await request(b.agent, 'browser_snapshot')
    expect(runtime.grantedId).toBe('session-b')
  })

  it('没有审批通道时是拒绝, 而不是静默放行', async () => {
    const { request, runtime } = makeHarness(undefined)
    const { agent } = makeAgent('session-a')

    // 无人可以同意, 所以不能悄悄取得 —— 那正是要避免的行为.
    const result = await request(agent, 'browser_snapshot')
    expect(result.kind).toBe('deny')
    expect(runtime.holdsBrowser(agent)).toBe(false)
  })

  it('关掉 askOnAcquire 才回到静默取得', async () => {
    const approval = makeApproval('rejected')
    const { request } = makeHarness(approval.service, false)
    const { agent } = makeAgent('session-a')

    const result = await request(agent, 'browser_snapshot')
    expect(result.kind).toBe('allow')
    // 这是显式选择的行为, 前提是用户自己关掉了那个开关.
    expect(approval.asks).toHaveLength(0)
  })

  it('browser_status 不申请: 它不碰浏览器', async () => {
    const approval = makeApproval('rejected')
    const { request } = makeHarness(approval.service)
    const { agent } = makeAgent('session-a')

    // 第二个会话因此能在申请之前先看清"现在归谁".
    const result = await request(agent, 'browser_status')
    expect(result.kind).toBe('allow')
    expect(approval.asks).toHaveLength(0)
  })

  it('申请清单里都是 browser_ 工具, 且不含两个免申请的', () => {
    // 清单与"真实注册的工具集合"的逐项比对放在 tests/unauthorized-access.test.ts: 那里能拿到
    // 真正注册出来的工具定义, 所以不必在这里再抄一份名字清单 —— 抄一份就会像这次一样,
    // 新增工具时忘了同步而误报.
    expect(BROWSER_TOOLS.size).toBeGreaterThan(0)
    for (const name of BROWSER_TOOLS) expect(name.startsWith('browser_')).toBe(true)
    // 这两个刻意不申请: status 只读本机状态, release 只是放弃.
    expect(BROWSER_TOOLS.has('browser_status')).toBe(false)
    expect(BROWSER_TOOLS.has('browser_release')).toBe(false)
  })

  it('执行点也会拒绝非持有者: 申请不是"建议", 而是硬约束', async () => {
    const approval = makeApproval('allowed-once')
    const { request, runtime } = makeHarness(approval.service)
    const a = makeAgent('session-a')
    const b = makeAgent('session-b')

    // 谁都没申请过时, 任何会话都不能直接执行 —— 这一条保证不会绕过审批悄悄取得.
    await expect(runtime.run(a.agent, new AbortController().signal, async () => 'x'))
      .rejects.toThrow(/还没有取得浏览器|征求用户同意/u)

    await request(a.agent, 'browser_open')
    // a 已获授权, 所以不会被这一层挡下 (它接下来会因为没有连接组件而在更后面失败, 这不是本
    // 条要测的东西).
    await expect(runtime.run(a.agent, new AbortController().signal, async () => 'x'))
      .rejects.not.toThrow(/还没有取得浏览器/u)

    // b 把驱动权要过去之后, a 就不再是持有者, 于是一样被拒.
    await request(b.agent, 'browser_open')
    await expect(runtime.run(a.agent, new AbortController().signal, async () => 'x'))
      .rejects.toThrow(/归会话 session-b 使用/u)
  })

  it('判定与理由生成的边界', () => {
    expect(needsBrowserConsent({ toolName: 'browser_click', holdsBrowser: false, enabled: true })).toBe(true)
    // 已经持有就不再问.
    expect(needsBrowserConsent({ toolName: 'browser_click', holdsBrowser: true, enabled: true })).toBe(false)
    // 关掉开关就不问.
    expect(needsBrowserConsent({ toolName: 'browser_click', holdsBrowser: false, enabled: false })).toBe(false)
    // 不碰浏览器的工具不问.
    expect(needsBrowserConsent({ toolName: 'browser_status', holdsBrowser: false, enabled: true })).toBe(false)

    // 有持有者时理由要指名道姓; 没有时要说清无人占用.
    expect(acquireReason('browser_click', {}, 'session-a')).toContain('session-a')
    expect(acquireReason('browser_click', {}, null)).toContain('没有会话占用')
    // 工具自带的理由要带进去, 那是模型对"为什么需要浏览器"的说明.
    expect(acquireReason('browser_open', { justification: '查今天的行情' }, null)).toContain('查今天的行情')
  })
})
