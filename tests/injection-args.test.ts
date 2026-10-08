/**
 * 注入参数的序列化边界.
 *
 * `chrome.scripting.executeScript` 传参走 JSON 序列化, 所以 `undefined` 会让调用直接
 * 失败, 而 Chrome 的报错既不说哪个参数也不说原因:
 *
 *   Error at property 'args': Error at index 1: Value is unserializable
 *
 * 真实踩过一次: 省略 `browser_scroll` 的 `amount` 时, 扩展把 `undefined` 原样放进参数
 * 数组, 于是"向下滚动一屏"这个最自然的调用必然失败, 而显式给 `amount` 就正常 —— 模型
 * 自己绕过去了, 所以问题只在省略参数时才现形.
 *
 * 这个测试守两件事:
 *   1. 扩展的 `runInTab` 边界会把 `undefined` 换成 `null` (注入函数用 `??` 判断缺省);
 *   2. 每个注入函数的调用点在**省略可选参数**时, 规整后的参数里不含 `undefined`.
 *
 * 第 2 条靠直接调用各个导出函数并拦截 executeScript 来验证, 因此新增一个"省略参数"的
 * 调用路径时, 只要它走的是同一个边界, 就自动被覆盖.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 上一次 executeScript 收到的注入参数. */
let lastArgs: unknown[] | undefined

/** 装一个假的 chrome API, 只实现本测试用到的部分. */
function installChromeStub(): void {
  const tab = { id: 1, url: 'https://example.com/', title: 'Example', windowId: 1, active: true, status: 'complete' }
  const chromeStub = {
    tabs: {
      get: async () => tab,
      query: async () => [tab],
      update: async () => tab,
      create: async () => tab,
      remove: async () => {},
    },
    scripting: {
      /** 记录参数并回一个合成结果, 让调用链继续走下去. */
      executeScript: async (injection: { args?: unknown[] }) => {
        lastArgs = injection.args
        // 返回一个足以让 unwrap 通过的结构; 具体内容不影响本测试.
        return [{ result: { ok: true, note: 'stub' } }]
      },
    },
    windows: { update: async () => ({}) },
    runtime: { id: 'stub', lastError: undefined },
  }
  ;(globalThis as unknown as Record<string, unknown>)['chrome'] = chromeStub
}

beforeEach(() => {
  lastArgs = undefined
  installChromeStub()
  vi.resetModules()
})

describe('注入参数的序列化边界', () => {
  it('省略 amount 的滚动不会把 undefined 送进页面', async () => {
    const page = await import('../extension/src/background/page.ts')
    // 这正是真机上失败的那一次调用: 只给方向, 不给像素数.
    await page.scrollInTab(1, 'down', undefined)
    expect(lastArgs, 'executeScript 应当被调用').toBeDefined()
    for (const [index, value] of lastArgs!.entries()) {
      expect(value, `参数第 ${index} 个是 undefined, 会让 Chrome 直接拒绝`).not.toBeUndefined()
    }
    // 尾部 undefined 直接摘掉, 页面里的 amount 就是 undefined, `??` 判断缺省成立.
    expect(lastArgs).toEqual(['down'])
  })

  it('显式给 amount 时原样传递', async () => {
    const page = await import('../extension/src/background/page.ts')
    await page.scrollInTab(1, 'up', 250)
    expect(lastArgs).toEqual(['up', 250])
  })

  it('其余注入调用点的参数里也不含 undefined', async () => {
    const page = await import('../extension/src/background/page.ts')
    const cases: [string, () => Promise<unknown>][] = [
      ['snapshot', () => page.snapshotPage(1)],
      ['click', () => page.clickByIndex(1, 'tok', 0)],
      ['fill', () => page.fillByIndex(1, 'tok', 0, '文字', false)],
      ['pressKey', () => page.pressKeyInTab(1, 'Enter')],
      ['scroll-up', () => page.scrollInTab(1, 'up', undefined)],
      ['text', () => page.readText(1)],
    ]
    for (const [label, run] of cases) {
      lastArgs = undefined
      await run()
      expect(lastArgs, `${label} 没有调用 executeScript`).toBeDefined()
      for (const [index, value] of lastArgs!.entries()) {
        expect(value, `${label} 的参数第 ${index} 个是 undefined`).not.toBeUndefined()
      }
    }
  })
})
