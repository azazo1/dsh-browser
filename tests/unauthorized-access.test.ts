/**
 * 未获授权时, 到底能不能对浏览器产生影响.
 *
 * 这是个安全边界问题, 所以答案必须来自**逐个工具的实际执行**, 而不是读代码后的印象. 本
 * 测试枚举全部已注册的 browser_* 工具, 在一个从未被授予驱动权的会话上执行它们, 然后断言:
 *
 *   - 桥一次调用都没有发生 (桥是唯一能驱动扩展的通道);
 *   - 也没有走到"启动 Chrome"那一步 —— 由错误信息证明, 因为那个守卫就在启动流程的最前面;
 *   - 唯一的例外是 browser_status (只读本机状态, 不碰浏览器) 与 browser_release (只放弃,
 *     不取得), 它们可以正常返回.
 *
 * 第二个方向同样重要: 即使某个资源被泄漏出去, 拿着它也不能驱动浏览器. 所以另有一条用例
 * 先取得资源, 再撤销授权, 然后直接调那个资源.
 *
 * 这组测试也在守将来: 新增一个工具却忘了把它纳入申请清单时, 只要它会触达桥, 这里就会红.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/config.ts'
import { BrowserRuntime, makeResource } from '../src/runtime.ts'
import { advancedTools } from '../src/tools/advanced.ts'
import { pageTools } from '../src/tools/page.ts'
import { screenshotTool } from '../src/tools/screenshot.ts'
import { sessionTools } from '../src/tools/session.ts'
import { BROWSER_TOOLS } from '../src/acquire.ts'

/**
 * 造一个记录所有调用的假桥.
 *
 * 只要它收到任何一次调用, 就说明"没经过申请也能影响浏览器", 所以它是本测试的核心探针.
 *
 * @returns 假桥与它的调用记录.
 */
function makeBridge(): {
  calls: { method: string, args: unknown }[]
  bridge: never
} {
  const calls: { method: string, args: unknown }[] = []
  const bridge = {
    token: 'tok',
    connectionState: { connected: false, extensionVersion: null, boundTabId: null, lastError: null, userScriptsAvailable: null },
    syncPairing: () => undefined,
    /**
     * 记录这次调用.
     * @param method 方法名.
     * @param args 参数.
     * @returns 占位结果.
     */
    call: async (method: string, args: unknown) => {
      calls.push({ method, args })
      return undefined as never
    },
  }
  return { calls, bridge: bridge as never }
}

/**
 * 造一个带作用域的假会话.
 *
 * @param id 会话 id.
 * @returns 假会话.
 */
function makeAgent(id: string): Agent {
  return {
    id,
    status: 'idle',
    ctx: {
      effect: (callback: () => () => void | Promise<void>, _name: string) => {
        const cleanup = callback()
        return () => { void cleanup() }
      },
      on: () => () => {},
    },
  } as unknown as Agent
}

/**
 * 组装全部工具.
 *
 * @param runtime 运行时.
 * @returns 工具定义清单.
 */
function allTools(runtime: BrowserRuntime): ToolDefinition[] {
  const deps = { runtime }
  return [
    ...sessionTools(deps),
    ...pageTools(deps),
    ...advancedTools(deps),
    screenshotTool({ ...deps, screenshotsDir: () => '/tmp/dsh-browser-none' }),
  ]
}

/**
 * 造一个真实的运行时 (配上假桥).
 *
 * @returns 运行时与假桥的调用记录.
 */
function makeRuntime(): { runtime: BrowserRuntime, calls: { method: string, args: unknown }[] } {
  const { calls, bridge } = makeBridge()
  // 用真实的 cordis Context, 这样 effect / logger / get 都是真实行为, 桩的边界只留在桥那一层.
  // 刻意不提供 webServer: 未授权的调用应当在需要它之前就被挡下.
  const ctx = new Context()
  // 库自己还要求"会话必须是活着的持有者" —— 它会去 agents 注册表里核对同一个对象. 这层是
  // 库提供的额外保护 (会话被回收后, 连它自己都不再认这个持有者), 所以这里要如实提供,
  // 否则测出来的"被拒"可能来自这层而不是我们要验的那道守卫.
  const live = new WeakSet<Agent>()
  ;(ctx as unknown as { provide: (name: string, value: unknown) => void }).provide('agents', {
    get: (id: string) => liveAgents.get(id),
  })
  void live
  const runtime = new BrowserRuntime(ctx, Config({ askOnAcquire: true }), bridge)
  return { runtime, calls }
}

/** 已登记的"活会话", 供假 agents 注册表按 id 查回来. */
const liveAgents = new Map<string, Agent>()

/**
 * 把一个会话登记为"活的".
 *
 * @param agent 会话.
 * @returns 同一个会话.
 */
function register(agent: Agent): Agent {
  liveAgents.set(agent.id, agent)
  return agent
}

/**
 * 造一个工具执行上下文.
 *
 * @param agent 发起会话.
 * @returns 执行上下文桩.
 */
function makeExec(agent: Agent): never {
  return {
    agent,
    signal: new AbortController().signal,
    callId: 'call-test',
    name: 'test',
    arguments: {},
  } as never
}

/** 每个工具的调用参数; 覆盖全部 browser_* 工具. */
const CALL_ARGS: Record<string, unknown> = {
  browser_open: { justification: '验证未授权行为' },
  browser_status: {},
  browser_tabs: {},
  browser_select_tab: { tabId: 1 },
  browser_close_tab: { tabId: 1 },
  browser_snapshot: {},
  browser_text: {},
  browser_click: { token: 'tok', index: 0 },
  browser_fill: { token: 'tok', index: 0, text: 'x' },
  browser_press_key: { key: 'Enter' },
  browser_scroll: { direction: 'down' },
  browser_navigate: { url: 'https://example.com/' },
  browser_wait: { text: 'x' },
  browser_query: { selector: 'a' },
  browser_hover: { token: 'tok', index: 0 },
  browser_upload: { file_paths: ['/tmp/definitely-missing-file'] },
  browser_screenshot: { format: 'png' },
  browser_evaluate: { expression: '1' },
  browser_release: {},
}

describe('未获授权时能否影响浏览器', () => {
  it('枚举到的工具与参数表一一对应 (新增工具时必须一并纳入)', () => {
    const { runtime } = makeRuntime()
    const names = allTools(runtime).map(tool => tool.name).sort()
    expect(names).toEqual(Object.keys(CALL_ARGS).sort())
  })

  it('全部工具都在申请清单内, 只有 browser_status 与 browser_release 例外', () => {
    // 清单漏了某个工具 -> 它会静默自动取得; 这条从两个方向夹住这个错误.
    expect(BROWSER_TOOLS.has('browser_status')).toBe(false)
    expect(BROWSER_TOOLS.has('browser_release')).toBe(false)
    const expected = Object.keys(CALL_ARGS)
      .filter(name => name !== 'browser_status' && name !== 'browser_release')
      .sort()
    expect([...BROWSER_TOOLS].sort()).toEqual(expected)
  })

  it('未授权时, 任何工具都不会让桥收到一次调用', async () => {
    const { runtime, calls } = makeRuntime()
    const outsider = register(makeAgent('session-outsider'))

    for (const tool of allTools(runtime)) {
      // 逐个真执行. 未授权的会话不该有任何一条路径能碰到浏览器.
      await tool.execute(CALL_ARGS[tool.name], makeExec(outsider)).catch(() => undefined)
    }

    // 只要有一条记录, 就说明存在绕过申请的路径.
    expect(calls).toEqual([])
  })

  it('未授权时, 会占用浏览器的工具都被拒, 而且理由指向"再发起一次调用去申请"', async () => {
    for (const name of BROWSER_TOOLS) {
      const { runtime, calls } = makeRuntime()
      const outsider = register(makeAgent('session-outsider'))
      const tool = allTools(runtime).find(candidate => candidate.name === name)
      expect(tool, `找不到工具 ${name}`).toBeDefined()

      const failure = await tool!.execute(CALL_ARGS[name], makeExec(outsider)).then(
        () => null,
        (error: unknown) => error,
      )
      expect(failure, `${name} 在未授权时没有失败`).not.toBeNull()
      expect(String(failure)).toContain('还没有取得浏览器')
      // 错误信息来自启动流程最前面那道守卫, 因此也证明没有启动 Chrome.
      expect(calls).toEqual([])
    }
  })

  it('browser_status 不需要授权, 但它也不碰浏览器', async () => {
    const { runtime, calls } = makeRuntime()
    const outsider = register(makeAgent('session-outsider'))
    const tool = allTools(runtime).find(candidate => candidate.name === 'browser_status')!

    // 它能成功返回 (第二个会话据此先看清"现在归谁"), 但依然不产生任何桥调用.
    const value = await tool.execute({}, makeExec(outsider)) as { text: string }
    expect(value.text).toContain('驱动权')
    expect(calls).toEqual([])
  })

  it('browser_release 不需要授权, 而且不会因此取得或放弃任何东西', async () => {
    const { runtime, calls } = makeRuntime()
    const outsider = register(makeAgent('session-outsider'))
    const tool = allTools(runtime).find(candidate => candidate.name === 'browser_release')!

    const value = await tool.execute({}, makeExec(outsider)) as { released: boolean, text: string }
    expect(value.released).toBe(false)
    expect(runtime.grantedId).toBeNull()
    expect(calls).toEqual([])
  })

  it('泄漏出去的资源拿到手也没用: 授权一旦转走, 旧资源立刻失效', () => {
    // 直接测真实代码用的那个构造函数: 资源是"能驱动浏览器"的凭据, 所以它的每次调用都要
    // 重新确认持有者仍被授予 —— 而不是在构造时把结论定下来.
    const { calls, bridge } = makeBridge()
    let granted = true
    const resource = makeResource({
      bridge,
      assertGranted: () => {
        if (!granted) throw new Error('本会话还没有取得浏览器')
      },
      onClose: () => {},
    })

    // 被授予时它能正常驱动.
    return resource.value.call('page.text', {}, new AbortController().signal).then(async () => {
      expect(calls).toHaveLength(1)

      // 授权被转给别人之后, 手上这份资源必须立刻不能用.
      granted = false
      await expect(resource.value.call('page.text', {}, new AbortController().signal))
        .rejects.toThrow(/还没有取得浏览器/u)
      // 被拒的那次没有产生任何调用.
      expect(calls).toHaveLength(1)
    })
  })
})
