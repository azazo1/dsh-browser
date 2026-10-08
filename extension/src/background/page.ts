/**
 * 页面操作的执行层: 把协议方法落到具体的标签页上.
 *
 * 所有注入都走 `chrome.scripting.executeScript` 的 ISOLATED world, 页面脚本看不到
 * 我们挂的状态. 注入函数本身定义在 injected.ts, 那里有"必须自包含"的硬约束说明.
 */

import { MAX_TEXT_CHARS } from '../../../shared/protocol.js'
import type { SnapshotResult } from '../../../shared/protocol.js'
import { clickElement, collectSnapshot, fillElement, pressKeyInPage, scrollPage, SNAPSHOT_KEY } from './injected.js'
import type { RawSnapshot } from './injected.js'
import { getTab, waitForComplete } from './tabs.js'

/** 单次快照列出的元素上限; 超过就截断, 避免清单淹没正文. */
const MAX_ELEMENTS = 400

/** 不能被脚本注入的页面协议前缀. */
const BLOCKED_SCHEMES = [
  'chrome://',
  'chrome-untrusted://',
  'chrome-extension://',
  'devtools://',
  'edge://',
  'about:',
  'view-source:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
]

/** 注入失败时抛出的错误, 带机器可读类别. */
export class PageError extends Error {
  /**
   * @param code 协议里的错误类别.
   * @param message 面向模型的中文说明.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PageError'
  }
}

/**
 * 判断一个地址是否禁止注入, 并给出原因.
 * @param url 目标地址.
 * @returns 禁止原因; 可注入时返回 null.
 */
function blockedReason(url: string): string | null {
  for (const scheme of BLOCKED_SCHEMES) {
    if (url.startsWith(scheme)) {
      return `Chrome 不允许扩展在 ${scheme} 页面上注入脚本. 请换一个普通网页, 例如 https:// 开头的站点.`
    }
  }
  return null
}

/**
 * 在标签页里执行一个注入函数并取回结果.
 *
 * @param tabId 目标标签页.
 * @param func 自包含的注入函数 (见 injected.ts 的约束).
 * @param args 传给注入函数的参数, 必须可 JSON 序列化.
 * @returns 注入函数的返回值.
 */
async function runInTab<R>(tabId: number, func: (...args: never[]) => R, args: unknown[]): Promise<R> {
  const tab = await getTab(tabId)
  const reason = blockedReason(tab.url)
  if (reason !== null) throw new PageError('injection-blocked', reason)
  let first: chrome.scripting.InjectionResult<unknown> | undefined
  try {
    // 注入函数的参数与返回类型由调用方保证一致, 但 executeScript 的类型无法表达这层
    // 关联; 在边界处断言一次, 之后按 unknown 收窄即可.
    const injected = chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: func as (...args: never[]) => unknown,
      args: args as never[],
    }) as Promise<chrome.scripting.InjectionResult<unknown>[]>
    first = (await injected)[0]
  } catch (error) {
    const message = String(error)
    if (message.includes('No tab with id')) {
      throw new PageError('stale-target', `标签页 ${tabId} 已经关闭, 请重新列出标签页`)
    }
    if (message.includes('Cannot access') || message.includes('The extensions gallery cannot be scripted')) {
      throw new PageError('injection-blocked', '该页面禁止扩展注入脚本, 请换一个普通网页')
    }
    throw new PageError('injection-blocked', `注入页面失败: ${message}`)
  }
  if (first === undefined) {
    throw new PageError('injection-blocked', '注入没有返回结果, 页面可能处于特殊状态 (例如正在导航)')
  }
  return first.result as R
}

/**
 * 处理注入函数返回的失败结构, 成功时原样返回.
 * @param value 注入函数的返回值.
 * @returns 成功时的值.
 */
function unwrap<T extends { ok: true }>(value: T | { ok: false, code: string, message: string }): T {
  if (value.ok) return value
  throw new PageError(value.code, value.message)
}

/**
 * 采集页面快照.
 * @param tabId 目标标签页.
 * @returns 归一化后的快照.
 */
export async function snapshotPage(tabId: number): Promise<SnapshotResult> {
  const raw = await runInTab<RawSnapshot>(tabId, collectSnapshot, [SNAPSHOT_KEY, MAX_TEXT_CHARS, MAX_ELEMENTS])
  return {
    url: raw.url,
    title: raw.title,
    token: raw.token,
    text: raw.text,
    elements: raw.elements,
    truncated: raw.truncated,
  }
}

/**
 * 按编号点击.
 * @param tabId 目标标签页.
 * @param token 快照 token.
 * @param index 元素编号.
 * @returns 命中说明.
 */
export async function clickByIndex(tabId: number, token: string, index: number): Promise<{ note: string }> {
  const value = await runInTab(tabId, clickElement, [SNAPSHOT_KEY, token, index])
  return { note: unwrap(value).note }
}

/**
 * 按编号填入文本.
 * @param tabId 目标标签页.
 * @param token 快照 token.
 * @param index 元素编号.
 * @param text 文本.
 * @param submit 是否提交.
 * @returns 命中说明.
 */
export async function fillByIndex(tabId: number, token: string, index: number, text: string, submit: boolean): Promise<{ note: string }> {
  const value = await runInTab(tabId, fillElement, [SNAPSHOT_KEY, token, index, text, submit])
  return { note: unwrap(value).note }
}

/**
 * 在页面里按键.
 * @param tabId 目标标签页.
 * @param key 按键名.
 * @returns 命中说明.
 */
export async function pressKeyInTab(tabId: number, key: string): Promise<{ note: string }> {
  const value = await runInTab(tabId, pressKeyInPage, [key])
  return { note: unwrap(value).note }
}

/**
 * 滚动页面.
 * @param tabId 目标标签页.
 * @param direction 方向.
 * @param amount 像素数.
 * @returns 命中说明.
 */
export async function scrollInTab(tabId: number, direction: 'up' | 'down', amount: number | undefined): Promise<{ note: string }> {
  const value = await runInTab(tabId, scrollPage, [direction, amount])
  return { note: unwrap(value).note }
}

/**
 * 读取页面正文.
 * @param tabId 目标标签页.
 * @returns 地址, 标题与正文.
 */
export async function readText(tabId: number): Promise<{ url: string, title: string, text: string, truncated: boolean }> {
  // 复用快照采集, 只是不返回元素清单, 保证两处对"正文"的定义一致.
  const raw = await runInTab<RawSnapshot>(tabId, collectSnapshot, [SNAPSHOT_KEY, MAX_TEXT_CHARS, 0])
  return { url: raw.url, title: raw.title, text: raw.text, truncated: raw.truncated }
}

/**
 * 导航到新地址并等待加载完成.
 *
 * @param tabId 目标标签页.
 * @param url 目标地址.
 * @param timeoutMs 等待上限.
 * @returns 导航后的地址与标题, 以及是否在超时前完成加载.
 */
export async function navigateTab(tabId: number, url: string, timeoutMs: number): Promise<{ url: string, title: string, completed: boolean }> {
  const tab = await getTab(tabId)
  const reason = blockedReason(url)
  if (reason !== null) throw new PageError('forbidden', reason)
  try {
    await chrome.tabs.update(tabId, { url })
  } catch (error) {
    throw new PageError('stale-target', `导航失败, 标签页 ${tabId} 可能已关闭: ${String(error)}`)
  }
  void tab
  const completed = await waitForComplete(tabId, timeoutMs)
  const after = await getTab(tabId)
  return { url: after.url, title: after.title, completed }
}

/**
 * 轮询等待页面出现指定文本.
 *
 * 在扩展侧轮询而不是在页面里挂一个长 Promise: 页面一旦导航, 注入的 Promise 会
 * 随着上下文销毁而永远不 resolve, 那会让工具调用一直挂到宿主超时.
 *
 * @param tabId 目标标签页.
 * @param needle 要等待的文本.
 * @param timeoutMs 等待上限.
 * @returns 是否找到, 以及说明.
 */
export async function waitForText(tabId: number, needle: string, timeoutMs: number): Promise<{ found: boolean, note: string }> {
  const deadline = Date.now() + timeoutMs
  let lastUrl = ''
  let lastTitle = ''
  for (;;) {
    try {
      const current = await readText(tabId)
      lastUrl = current.url
      lastTitle = current.title
      if (current.text.includes(needle)) {
        return { found: true, note: `在 ${lastUrl} 找到了 "${needle}"` }
      }
    } catch (error) {
      if (error instanceof PageError && error.code === 'stale-target') throw error
      // 导航过程中注入会短暂失败, 属于预期情况, 继续轮询.
    }
    if (Date.now() >= deadline) {
      return {
        found: false,
        note: `等待 ${timeoutMs}ms 后仍未在 ${lastUrl} (${lastTitle}) 找到 "${needle}"; 可能是加载未完成或文本在 iframe 内`,
      }
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}
