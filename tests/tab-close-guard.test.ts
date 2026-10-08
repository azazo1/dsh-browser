/**
 * 关闭标签页的保护.
 *
 * `chrome.tabs.remove` 在目标窗口只剩一个标签页时, 实际效果是**关掉整个窗口** —— 而若那又是
 * 唯一窗口, Chrome 会退出, 扩展, native host 与桥的链路一起消失. 那不是"关掉一个标签页",
 * 而是把正在工作的浏览器拆掉, 而且失败现象 (后续调用全报链路断开) 离原因很远.
 *
 * 所以这条保护必须真的生效, 而不是只在注释里说明. 这里用 chrome 桩直接驱动扩展侧的
 * `closeTab`, 两个方向都验: 不该关时拒绝且不调用 remove, 该关时正常关掉.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { closeTab } from '../extension/src/background/tabs.ts'

/** 上一次是否真的调用了 chrome.tabs.remove. */
let removed: number[] = []

/** 当前"窗口里有几个标签页", 由每个用例设置. */
let siblingsInWindow: number

/**
 * 装一个只实现 closeTab 真正用到的那部分 chrome API 的桩.
 */
function installChromeStub(): void {
  const makeTab = (id: number) => ({
    id,
    url: 'https://example.com/',
    title: 'Example',
    active: true,
    windowId: 7,
    status: 'complete',
  })
  const chromeStub = {
    tabs: {
      get: async (id: number) => makeTab(id),
      // closeTab 用 query({windowId}) 数同窗口的标签页.
      query: async () => Array.from({ length: siblingsInWindow }, (_unused, index) => makeTab(index + 1)),
      remove: async (id: number) => { removed.push(id) },
    },
  }
  ;(globalThis as unknown as Record<string, unknown>)['chrome'] = chromeStub
}

beforeEach(() => {
  removed = []
  siblingsInWindow = 2
  installChromeStub()
})

describe('关闭标签页', () => {
  it('窗口里还有别的标签页时正常关闭', async () => {
    siblingsInWindow = 3
    await closeTab(2)
    expect(removed).toEqual([2])
  })

  it('目标窗口只剩一个标签页时拒绝, 并且不调用 remove', async () => {
    siblingsInWindow = 1
    // 拒绝的理由要说清"为什么"以及"下一步怎么做", 否则调用方只会看到一句莫名的失败.
    await expect(closeTab(1)).rejects.toThrow(/最后一个标签页/u)
    await expect(closeTab(1)).rejects.toThrow(/browser_open/u)
    // 关键: 拒绝时绝不能已经把它关掉了.
    expect(removed).toEqual([])
  })

  it('错误类别是 last-tab, 供宿主识别', async () => {
    siblingsInWindow = 1
    await closeTab(1).then(
      () => { throw new Error('本该拒绝') },
      (error: { code?: string }) => { expect(error.code).toBe('last-tab') },
    )
  })
})
