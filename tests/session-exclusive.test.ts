/**
 * 库自带的 `exclusive` 是怎么工作的 (以及本插件为什么不采用它).
 *
 * 这组测试测的是**第三方库** `SessionResources` 的行为, 目的是把"为什么不能只用它的
 * exclusive"钉住, 免得后来有人图省事把它改回去.
 *
 * 它的语义是这样的:
 *
 *   1. 一个会话取得资源后, 另一个会话**被硬拒**, 试都试不了;
 *   2. 释放只发生在**会话作用域被回收**时 —— 不是每轮对话结束, 也不是请求结束;
 *   3. 所以只要那个会话还活着, 它就一直握着, 而且没有任何办法让它交出来.
 *
 * 第 3 条正是问题: 用户要的是"另一个会话可以申请, 由我决定现在归谁". 而 exclusive 提供的
 * 是"先到先得, 而且要等对方会话结束", 中间没有任何让出的余地 —— 库也没有提供单独释放某个
 * 会话的公开接口 (内部那个 `closeEntry` 是私有的).
 *
 * 所以本插件**关掉** `exclusive`, 改用自己那层"授予"来仲裁 (`src/runtime.ts` 的
 * granted / grant / release), 授予的转移必须经过用户审批 (`src/acquire.ts`).
 *
 * 这组测试同时说明另一件事: 光靠会话结束来释放是不够的 —— 这就是为什么要加
 * `browser_release` 与"申请".
 */

import { describe, expect, it, vi } from 'vitest'
import { SessionResources } from '@deepseek-ai/dsh-experimental-browser-use-runtime'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 一个可以被回收作用域的假 agent. */
interface FakeAgent {
  agent: Agent
  /** 回收这个 agent 的会话作用域, 等价于会话结束. */
  disposeScope: () => Promise<void>
}

/**
 * 造一个假 agent.
 *
 * 只实现 `SessionResources` 真正用到的那几处: `id`, 一张能在注册表里查到的表, 以及
 * `ctx.effect` —— 它注册的清理函数正是释放资源的那条钩子.
 *
 * @param registry 所有存活 agent 的注册表, 对应 dsh 的 `agents` 服务.
 * @param id 会话 id.
 * @returns 假 agent 与它的作用域回收入口.
 */
function makeAgent(registry: Map<string, Agent>, id: string): FakeAgent {
  const cleanups: (() => Promise<void> | void)[] = []
  const agent = {
    id,
    ctx: {
      /**
       * 注册一个随作用域回收而执行的清理函数, 并返回可以主动触发它的函数.
       * @param callback 返回清理函数.
       * @param _name 名称.
       * @returns 触发清理的函数.
       */
      effect: (callback: () => () => Promise<void> | void, _name: string) => {
        const cleanup = callback()
        cleanups.push(cleanup)
        return () => { void cleanup() }
      },
    },
  } as unknown as Agent
  registry.set(id, agent)
  return {
    agent,
    disposeScope: async () => {
      // 会话结束后它就不该再出现在注册表里.
      registry.delete(id)
      for (const cleanup of cleanups) await cleanup()
    },
  }
}

/**
 * 造一个假的插件上下文.
 * @param registry 存活 agent 的注册表.
 * @returns 最小上下文桩.
 */
function makeContext(registry: Map<string, Agent>): unknown {
  return {
    get: (service: string) => (service === 'agents' ? { get: (id: string) => registry.get(id) } : undefined),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  }
}

/**
 * 造一组资源提供者.
 * @returns 提供者与其打开过的次数.
 */
function makeProvider(): {
  options: ConstructorParameters<typeof SessionResources<{ opened: number }>>[1]
  opened: { count: number, closed: number }
} {
  const opened = { count: 0, closed: 0 }
  return {
    opened,
    options: {
      label: 'dsh-browser',
      exclusive: true,
      open: async () => {
        opened.count += 1
        return { opened: opened.count }
      },
    },
  } as never
}

describe('库自带的 exclusive 语义 (本插件关掉了它)', () => {
  it('一个会话取得后, 另一个会话被硬拒 (没有申请余地)', async () => {
    const registry = new Map<string, Agent>()
    const ctx = makeContext(registry)
    const opened = { count: 0, closed: 0 }
    const resources = new SessionResources<{ opened: number }>(ctx as never, {
      label: 'dsh-browser',
      exclusive: true,
      open: async () => {
        opened.count += 1
        return { value: { opened: opened.count }, close: async () => { opened.closed += 1 } }
      },
    })

    const first = makeAgent(registry, 'session-a')
    const second = makeAgent(registry, 'session-b')

    // 第一个会话取得资源.
    await resources.get(first.agent)
    expect(opened.count).toBe(1)

    // 第二个会话在**此时**不被准入 —— 它连试都不用试, 这就是 exclusive 的意义.
    expect(resources.available(second.agent)).toBe(false)
    await expect(resources.get(second.agent)).rejects.toThrow(/reserved by another Session/u)
  })

  it('拒绝之后, 第一个会话仍然可以继续用', async () => {
    const registry = new Map<string, Agent>()
    const ctx = makeContext(registry)
    let count = 0
    const resources = new SessionResources<{ opened: number }>(ctx as never, {
      label: 'dsh-browser',
      exclusive: true,
      open: async () => ({ value: { opened: ++count }, close: async () => {} }),
    })

    const first = makeAgent(registry, 'session-a')
    const second = makeAgent(registry, 'session-b')
    await resources.get(first.agent)
    await expect(resources.get(second.agent)).rejects.toThrow()
    // 被拒绝的会话不该影响持有者; 而且持有者复用同一份资源, 不会重复打开.
    expect(resources.available(first.agent)).toBe(true)
    await expect(resources.get(first.agent)).resolves.toEqual({ opened: 1 })
    expect(count).toBe(1)
  })

  it('释放只发生在会话作用域被回收时, 之后另一个会话才能用', async () => {
    const registry = new Map<string, Agent>()
    const ctx = makeContext(registry)
    let count = 0
    const resources = new SessionResources<{ opened: number }>(ctx as never, {
      label: 'dsh-browser',
      exclusive: true,
      open: async () => ({ value: { opened: ++count }, close: async () => {} }),
    })

    const first = makeAgent(registry, 'session-a')
    const second = makeAgent(registry, 'session-b')

    await resources.get(first.agent)
    expect(resources.available(second.agent)).toBe(false)

    // 会话结束: 作用域被回收. 这就是释放的那一刻 —— 不是每轮对话结束, 也不是请求结束.
    await first.disposeScope()

    // 资源回到无人占用, 第二个会话随即可以取得, 并拿到属于它自己的一份.
    expect(resources.available(second.agent)).toBe(true)
    await expect(resources.get(second.agent)).resolves.toEqual({ opened: 2 })
  })

  it('会话活着就一直握着: 反复调用不会释放, 也不会重新打开', async () => {
    const registry = new Map<string, Agent>()
    const ctx = makeContext(registry)
    let count = 0
    const resources = new SessionResources<{ opened: number }>(ctx as never, {
      label: 'dsh-browser',
      exclusive: true,
      open: async () => ({ value: { opened: ++count }, close: async () => {} }),
    })

    const first = makeAgent(registry, 'session-a')
    const second = makeAgent(registry, 'session-b')
    await resources.get(first.agent)

    // 反复取用 (等价于这个会话里连续发起多次浏览器操作) 不该释放, 也不该重新打开.
    for (let i = 0; i < 3; i += 1) await resources.get(first.agent)
    expect(count).toBe(1)
    expect(resources.available(second.agent)).toBe(false)
  })
})
