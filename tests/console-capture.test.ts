/**
 * console 抓取.
 *
 * 覆盖两层:
 *   1. 纯映射函数: CDP 的 RemoteObject / consoleAPICalled / exceptionThrown 到条目的转换,
 *      以及 onDetach 原因的翻译 —— 这些是产出质量的根, 直接逐字段断言.
 *   2. 生命周期: 用 chrome 桩驱动 start → 事件 → read → stop 的真实流程, 以及 SW 重启后从
 *      storage.session 恢复, attachment 丢失时把中断原因报告出来而不是静默丢数据.
 *
 * console.ts 的模块级状态按模块实例缓存, 所以每个用例都用 `vi.resetModules()` + 动态
 * import 重新加载, storage 桩放在模块外面, 跨"重启"保留.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  describeDetachReason,
  formatRemoteObject,
  mapConsoleApiCalled,
  mapExceptionThrown,
} from '../extension/src/background/console.ts'
import type { CdpRemoteObject } from '../extension/src/background/console.ts'

// ---------------------------------------------------------------------------
// 纯映射函数.
// ---------------------------------------------------------------------------

describe('RemoteObject 转文本', () => {
  it('字符串值带引号, 与浏览器 console 展示一致', () => {
    expect(formatRemoteObject({ type: 'string', value: 'hi' })).toBe('"hi"')
  })

  it('原始值直接转字符串', () => {
    expect(formatRemoteObject({ type: 'number', value: 42 })).toBe('42')
    expect(formatRemoteObject({ type: 'boolean', value: false })).toBe('false')
    expect(formatRemoteObject({ type: 'object', subtype: 'null', value: null })).toBe('null')
  })

  it('对象优先用 preview 摘要, overflow 时加省略号', () => {
    const object: CdpRemoteObject = {
      type: 'object',
      preview: {
        type: 'object',
        properties: [
          { name: 'a', type: 'number', value: '1' },
          { name: 'b', type: 'string', value: '"x"' },
        ],
      },
    }
    expect(formatRemoteObject(object)).toBe('{a: 1, b: "x"}')
    const array: CdpRemoteObject = {
      type: 'object',
      preview: {
        type: 'array',
        overflow: true,
        properties: [{ name: '0', type: 'number', value: '1' }],
      },
    }
    expect(formatRemoteObject(array)).toBe('[0: 1, …]')
  })

  it('没有 preview 时依次退回 unserializableValue, description 与类型名', () => {
    expect(formatRemoteObject({ type: 'symbol', unserializableValue: '<Symbol>' })).toBe('<Symbol>')
    expect(formatRemoteObject({ type: 'function', description: 'function foo() {}' })).toBe('function foo() {}')
    expect(formatRemoteObject({ type: 'object' })).toBe('[object]')
  })
})

describe('CDP 事件到条目', () => {
  it('consoleAPICalled: 级别归一, 参数空格拼接, 行号从 0 基转 1 基', () => {
    const entry = mapConsoleApiCalled(3, {
      type: 'warning',
      args: [{ type: 'string', value: 'a' }, { type: 'number', value: 2 }],
      stackTrace: [{ url: 'https://example.com/app.js', lineNumber: 11, columnNumber: 4 }],
      timestamp: 123,
    })
    expect(entry).toMatchObject({
      seq: 3,
      level: 'warning',
      type: 'warning',
      text: '"a" 2',
      url: 'https://example.com/app.js',
      line: 12,
      timestamp: 123,
    })
  })

  it('展示类命令 (dir/table 等) 归入 other, 原始 type 保留', () => {
    const entry = mapConsoleApiCalled(1, { type: 'dir', args: [], timestamp: 1 })
    expect(entry.level).toBe('other')
    expect(entry.type).toBe('dir')
  })

  it('console.assert 失败按 error 处理', () => {
    const entry = mapConsoleApiCalled(1, { type: 'assert', args: [], timestamp: 1 })
    expect(entry.level).toBe('error')
  })

  it('exceptionThrown: 优先异常 description, 兜底 details.text', () => {
    const withDescription = mapExceptionThrown(1, {
      timestamp: 5,
      exceptionDetails: {
        exception: { description: 'TypeError: x is not a function' },
        url: 'https://example.com/',
        lineNumber: 0,
      },
    })
    expect(withDescription).toMatchObject({
      level: 'error',
      type: 'exception',
      text: 'TypeError: x is not a function',
      url: 'https://example.com/',
      line: 1,
    })
    const fallback = mapExceptionThrown(2, { exceptionDetails: { text: 'Uncaught' } })
    expect(fallback.text).toBe('Uncaught')
    expect(fallback.url).toBeNull()
  })

  it('onDetach 原因翻成中文, 未知原因保留原始值', () => {
    expect(describeDetachReason('canceled_by_user')).toContain('提示条')
    expect(describeDetachReason('target_closed')).toContain('关闭')
    expect(describeDetachReason('weird_reason')).toContain('weird_reason')
  })
})

// ---------------------------------------------------------------------------
// 生命周期: chrome 桩 + 动态 import.
// ---------------------------------------------------------------------------

/** 一次 chrome 桩的句柄. */
interface Stub {
  /** 传给 onEvent / onDetach 监听器的事件. */
  listeners: { event: Function[], detach: Function[] }
  /** attach / detach / sendCommand 的调用记录. */
  calls: { attach: [number, string][], detach: number[], commands: [number, string][] }
  /** storage.session 的内容, 跨模块重载保留. */
  store: Map<string, unknown>
}

/** 上一轮的桩; beforeEach 里重装. */
let stub: Stub

/** sendCommand 抛错时模拟 attachment 丢失; 由用例按需设置. */
let sendCommandFailure: Error | undefined

/**
 * 装一个只实现 console.ts 用到的 chrome API 的桩.
 */
function installChromeStub(): void {
  const listeners = { event: [] as Function[], detach: [] as Function[] }
  const calls = { attach: [] as [number, string][], detach: [] as number[], commands: [] as [number, string][] }
  const store = new Map<string, unknown>()
  const chromeStub = {
    debugger: {
      attach: async (target: { tabId: number }, version: string) => {
        calls.attach.push([target.tabId, version])
      },
      detach: async (target: { tabId: number }) => {
        calls.detach.push(target.tabId)
      },
      sendCommand: async (target: { tabId: number }, method: string) => {
        if (sendCommandFailure !== undefined) throw sendCommandFailure
        calls.commands.push([target.tabId, method])
        return {}
      },
      onEvent: { addListener: (fn: Function) => { listeners.event.push(fn) } },
      onDetach: { addListener: (fn: Function) => { listeners.detach.push(fn) } },
    },
    storage: {
      session: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
        remove: async (key: string) => { store.delete(key) },
      },
    },
  }
  ;(globalThis as unknown as Record<string, unknown>)['chrome'] = chromeStub
  stub = { listeners, calls, store }
}

/** 等异步事件处理与 storage 写入链跑完. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * 加载一个全新的 console.ts 模块实例 (模块级状态归零).
 *
 * 同时清掉桩上的监听器: 旧实例的监听器随旧 SW 一起"死掉", 不再收到事件 —— 否则新旧
 * 两个实例都会处理事件, 恢复语义的测试会数出双份条目.
 */
async function freshModule() {
  vi.resetModules()
  stub.listeners.event.length = 0
  stub.listeners.detach.length = 0
  return await import('../extension/src/background/console.ts')
}

/** 向所有 onEvent 监听器派发一次 consoleAPICalled. */
function emitConsoleApiCalled(tabId: number, type: string, args: CdpRemoteObject[]): void {
  for (const listener of stub.listeners.event) {
    listener({ tabId }, 'Runtime.consoleAPICalled', { type, args, timestamp: 1 })
  }
}

beforeEach(() => {
  sendCommandFailure = undefined
  installChromeStub()
})

describe('console 抓取生命周期', () => {
  it('start attach 并开 Runtime, 事件进入缓冲, read drain 后清空', async () => {
    const mod = await freshModule()
    mod.installConsoleListeners()
    const started = await mod.startCapture(7)
    expect(started.tabId).toBe(7)
    expect(stub.calls.attach).toEqual([[7, '1.3']])
    expect(stub.calls.commands).toEqual([[7, 'Runtime.enable']])

    emitConsoleApiCalled(7, 'log', [{ type: 'string', value: 'hello' }])
    emitConsoleApiCalled(7, 'error', [{ type: 'string', value: 'boom' }])
    await flush()

    const first = await mod.readEntries(0)
    expect(first.entries.map(entry => entry.level)).toEqual(['log', 'error'])
    expect(first.capturing).toBe(true)
    expect(first.interrupted).toBeNull()

    const second = await mod.readEntries(0)
    expect(second.entries).toEqual([])
  })

  it('别的标签页的事件不进缓冲', async () => {
    const mod = await freshModule()
    mod.installConsoleListeners()
    await mod.startCapture(7)
    emitConsoleApiCalled(8, 'log', [{ type: 'string', value: 'other tab' }])
    await flush()
    const result = await mod.readEntries(0)
    expect(result.entries).toEqual([])
  })

  it('stop 分离调试器并返回剩余条目', async () => {
    const mod = await freshModule()
    mod.installConsoleListeners()
    await mod.startCapture(7)
    emitConsoleApiCalled(7, 'log', [{ type: 'string', value: 'last words' }])
    await flush()
    const stopped = await mod.stopCapture()
    expect(stub.calls.detach).toEqual([7])
    expect(stopped.capturing).toBe(false)
    expect(stopped.entries).toHaveLength(1)
    // 主动 stop 不算中断.
    expect(stopped.interrupted).toBeNull()
  })

  it('用户点掉提示条会中断抓取, read 报告原因', async () => {
    const mod = await freshModule()
    mod.installConsoleListeners()
    await mod.startCapture(7)
    for (const listener of stub.listeners.detach) listener({ tabId: 7 }, 'canceled_by_user')
    await flush()
    const result = await mod.readEntries(0)
    expect(result.capturing).toBe(false)
    expect(result.interrupted).toContain('提示条')
  })

  it('环形缓冲超过上限时淘汰最旧', async () => {
    const mod = await freshModule()
    mod.installConsoleListeners()
    await mod.startCapture(7)
    for (let index = 0; index < 1100; index += 1) {
      emitConsoleApiCalled(7, 'log', [{ type: 'number', value: index }])
    }
    await flush()
    const result = await mod.readEntries(0)
    expect(result.entries).toHaveLength(1000)
    // 最旧的 100 条被淘汰: 第一条是第 100 次调用 (seq 从 1 起, 1..1100).
    expect(result.entries[0]?.seq).toBe(101)
    expect(result.entries.at(-1)?.seq).toBe(1100)
  })

  it('从未开始过就 read 会给出可自我纠正的错误', async () => {
    const mod = await freshModule()
    mod.installConsoleListeners()
    await expect(mod.readEntries(0)).rejects.toThrow(/action:"start"/u)
  })

  it('没开始过时 stop 是无害的空操作', async () => {
    const mod = await freshModule()
    mod.installConsoleListeners()
    const stopped = await mod.stopCapture()
    expect(stopped).toMatchObject({ entries: [], capturing: false, interrupted: null })
  })
})

describe('SW 重启恢复', () => {
  it('重启后从 storage 恢复条目; attachment 已丢时标记中断而不是丢数据', async () => {
    // 第一段生命周期: start, 收几条, 然后"SW 被杀" (重置模块, storage 保留).
    {
      const mod = await freshModule()
      mod.installConsoleListeners()
      await mod.startCapture(7)
      emitConsoleApiCalled(7, 'log', [{ type: 'string', value: 'before restart' }])
      await flush()
    }
    // 第二段: 新模块实例从 storage 恢复; 此时 debugger attachment 已经不在了,
    // 探活的 sendCommand 必然失败.
    sendCommandFailure = new Error('Not attached')
    const mod = await freshModule()
    mod.installConsoleListeners()
    const result = await mod.readEntries(0)
    expect(result.entries.map(entry => entry.text)).toEqual(['"before restart"'])
    expect(result.capturing).toBe(false)
    expect(result.interrupted).toContain('重启')
  })

  it('重启后 attachment 还在时抓取继续', async () => {
    {
      const mod = await freshModule()
      mod.installConsoleListeners()
      await mod.startCapture(7)
      await flush()
    }
    // attachment 仍活着: 探活成功, 事件照常进入缓冲.
    const mod = await freshModule()
    mod.installConsoleListeners()
    emitConsoleApiCalled(7, 'log', [{ type: 'string', value: 'after restart' }])
    await flush()
    const result = await mod.readEntries(0)
    expect(result.capturing).toBe(true)
    expect(result.entries).toHaveLength(1)
  })
})
