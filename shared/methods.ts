/**
 * 扩展支持的方法清单及其参数与返回类型.
 *
 * 这些名字是宿主与扩展之间的私有约定, 不是模型可见的工具名. 模型看到的工具名
 * 在 src/tools/ 里定义, 由工具层翻译成这里的方法调用.
 */

import type { SnapshotResult, TabInfo } from './protocol.js'

/** 扩展侧支持的全部方法名. */
export type BrowserMethod =
  | 'tabs.list'
  | 'tabs.activate'
  | 'tabs.open'
  | 'tabs.close'
  | 'page.snapshot'
  | 'page.navigate'
  | 'page.click'
  | 'page.fill'
  | 'page.pressKey'
  | 'page.scroll'
  | 'page.text'
  | 'page.waitFor'

/** 方法名到 参数/返回 的映射, 供两侧共用做类型约束. */
export interface MethodContract {
  'tabs.list': { args: Record<string, never>, result: TabInfo[] }
  'tabs.activate': { args: { tabId: number }, result: TabInfo }
  'tabs.open': { args: { url: string }, result: TabInfo }
  'tabs.close': { args: { tabId: number }, result: { closed: true } }
  'page.snapshot': { args: Record<string, never>, result: SnapshotResult }
  'page.navigate': { args: { url: string }, result: { url: string, title: string } }
  'page.click': { args: { token: string, index: number }, result: PageActionResult }
  'page.fill': { args: { token: string, index: number, text: string, submit?: boolean }, result: PageActionResult }
  'page.pressKey': { args: { key: string }, result: PageActionResult }
  'page.scroll': { args: { direction: 'up' | 'down', amount?: number }, result: PageActionResult }
  'page.text': { args: Record<string, never>, result: { url: string, title: string, text: string, truncated: boolean } }
  'page.waitFor': { args: { text: string, timeoutMs?: number }, result: { found: boolean, note: string } }
}

/**
 * 一次页面操作的结果; 操作完成不代表结果符合预期, 需要重新快照确认.
 *
 * 这里**没有 `ok` 字段**, 是有意的: 失败在扩展侧就抛成错误帧 (见 injected.ts 里那个
 * 判别联合, 由 page.ts 的 unwrap 转成抛出), 所以能走到"返回一个结果"这一步就意味着
 * 成功. 曾经这里声明过 `ok: true` 而扩展实现没返回它, 结果四个操作工具的产物里多出
 * 一个 `undefined`, 被 harness 的 lossless-JSON 检查全数拒掉 —— 而类型系统看不出这层
 * 不一致, 因为两侧由这份声明连接, 实现压根不受它约束. 少一个冗余字段就少一处能漂移
 * 的地方.
 */
export interface PageActionResult {
  /** 补充说明, 例如点击命中了什么元素. */
  note: string
}

/** 取某个方法的参数类型. */
export type MethodArgs<M extends BrowserMethod> = MethodContract[M]['args']

/** 取某个方法的返回类型. */
export type MethodResult<M extends BrowserMethod> = MethodContract[M]['result']

/** 运行时校验用的方法名清单. */
export const BROWSER_METHODS: readonly BrowserMethod[] = [
  'tabs.list',
  'tabs.activate',
  'tabs.open',
  'tabs.close',
  'page.snapshot',
  'page.navigate',
  'page.click',
  'page.fill',
  'page.pressKey',
  'page.scroll',
  'page.text',
  'page.waitFor',
]

/** 判断一个字符串是否是已知方法名. */
export function isBrowserMethod(value: string): value is BrowserMethod {
  return (BROWSER_METHODS as readonly string[]).includes(value)
}
