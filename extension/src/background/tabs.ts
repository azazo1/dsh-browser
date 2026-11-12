/**
 * 标签页查询与绑定.
 *
 * 绑定模型是有意收紧的: 页面操作只作用于"被绑定"的那一个标签页, 绑定由显式的
 * `tabs.activate` (或 `tabs.open`) 建立. 这样模型不会在用户切来切去的时候顺手
 * 操作到别的标签页, 也不会因为"当前活动标签"这种隐式状态而误伤用户正在看的页面.
 */

import type { TabInfo } from '../../../shared/protocol.js'
import { PageError } from './errors.js'

/** 把 chrome 的 Tab 描述转成协议里的 TabInfo. */
export function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    id: tab.id ?? -1,
    url: tab.url ?? tab.pendingUrl ?? '',
    title: tab.title ?? '',
    active: tab.active === true,
    windowId: tab.windowId ?? -1,
  }
}

/** 列出所有窗口里的普通标签页, 排除扩展页和无 id 的条目. */
export async function listTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({})
  return tabs
    .filter(tab => typeof tab.id === 'number')
    .map(toTabInfo)
}

/**
 * 读取一个标签页.
 * @param tabId 标签页 id.
 * @returns 标签页描述; 不存在时抛错.
 */
export async function getTab(tabId: number): Promise<TabInfo> {
  try {
    const tab = await chrome.tabs.get(tabId)
    return toTabInfo(tab)
  } catch (error) {
    throw new Error(`标签页 ${tabId} 不存在或已关闭: ${String(error)}`, { cause: error })
  }
}

/**
 * 在后台新建标签页并等它完成首次加载.
 *
 * `active: false` 是有意的: 新建标签页只为了给模型一个落点, 不该把用户的注意力从
 * 正在做的事情上拽走. Chrome 会在后台完成加载, 后续的注入脚本操作同样可用.
 *
 * @param url 目标地址.
 * @returns 新标签页描述.
 */
export async function openTab(url: string): Promise<TabInfo> {
  const tab = await chrome.tabs.create({ url, active: false })
  if (typeof tab.id !== 'number') throw new Error('新建标签页没有返回 id')
  await waitForComplete(tab.id, 20_000)
  return getTab(tab.id)
}

/**
 * 校验标签页存在并把它作为绑定目标, 全程不改变用户的可见状态.
 *
 * 这里刻意**不**调用 `tabs.update({active:true})` 或 `windows.update({focused:true})`:
 * 绑定只是一个"后续页面操作作用于谁"的约定, 把 Chrome 抢到前台会打断用户正在做的事.
 * 后台标签页同样可以注入脚本, 点击与填入走的都是合成事件, 不需要窗口在前台.
 *
 * @param tabId 标签页 id.
 * @returns 标签页描述.
 */
export async function bindTab(tabId: number): Promise<TabInfo> {
  return getTab(tabId)
}

/**
 * 关闭一个标签页.
 *
 * **拒绝关闭所在窗口的最后一个标签页**: `chrome.tabs.remove` 在这种情况下的实际效果是关掉
 * 整个窗口, 而如果那又是唯一窗口, Chrome 会退出 —— 扩展, native host 与桥的链路随之一起消失.
 * 那不是"关掉一个标签页", 而是把正在工作的浏览器拆掉, 失败现象 (后续调用全部报链路断开) 也
 * 离原因很远. 调用方真正想要"清空"时, 先在同一窗口开一个新标签页即可.
 *
 * @param tabId 标签页 id.
 * @throws PageError 目标是所在窗口的最后一个标签页时抛出.
 */
export async function closeTab(tabId: number): Promise<void> {
  const target = await getTab(tabId)
  const siblings = await chrome.tabs.query({ windowId: target.windowId })
  if (siblings.length <= 1) {
    throw new PageError(
      'last-tab',
      `标签页 ${tabId} 是它所在窗口的最后一个标签页, 关掉它会连带关闭窗口 (以及可能退出 Chrome 并断开整条链路). `
      + '请先在同一窗口打开一个新标签页 (browser_open 传 url 即可), 再关闭这一个.',
    )
  }
  await chrome.tabs.remove(tabId)
}

/**
 * 等一个标签页的加载状态变成 complete.
 *
 * 采用轮询而不是监听 onUpdated: 监听需要处理"事件在监听注册前就结束了"的竞态,
 * 轮询在这种情况下天然正确, 代价只是最坏多等一个轮询间隔.
 *
 * @param tabId 标签页 id.
 * @param timeoutMs 超时毫秒.
 * @returns 是否在超时前完成.
 */
export async function waitForComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.status === 'complete') return true
    } catch {
      return false
    }
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}
