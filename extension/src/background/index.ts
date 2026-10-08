/**
 * 扩展后台 (MV3 service worker) 入口.
 *
 * 职责只有两件:
 *   1. 维持与 native host 的连接 (native.ts).
 *   2. 把宿主发来的调用分派到标签页或页面上, 并回帧.
 *
 * 这里不实现任何"猜测端口"或"探测宿主"的逻辑, 那是 native messaging 换掉的东西.
 */

import { NATIVE_HOST_NAME, PROTOCOL_VERSION } from '../../../shared/protocol.js'
import type { CallFrame, OutboundFrame } from '../../../shared/protocol.js'
import { isBrowserMethod } from '../../../shared/methods.js'
import { NativeBridge } from './native.js'
import type { BridgeStatus } from './native.js'
import {
  PageError,
  clickByIndex,
  fillByIndex,
  hoverByIndex,
  navigateTab,
  pressKeyInTab,
  queryInTab,
  readText,
  scrollInTab,
  snapshotPage,
  uploadAbortInTab,
  uploadBeginInTab,
  uploadChunkInTab,
  uploadCommitInTab,
  waitForText,
} from './page.js'
import { captureTab } from './screenshot.js'
import { evaluateInTab } from './evaluate.js'
import { activateTab, closeTab, getTab, listTabs, openTab } from './tabs.js'

/** 单条日志的前缀, 便于在 chrome://extensions 的日志里筛出本扩展. */
const LOG_PREFIX = '[dsh-browser]'

/** 结构化日志; service worker 没有 console 之外的落点. */
function log(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
  const line = `${LOG_PREFIX} ${message}`
  if (level === 'error') console.error(line, detail ?? '')
  else if (level === 'warn') console.warn(line, detail ?? '')
  else console.log(line, detail ?? '')
}

/**
 * 当前绑定的标签页.
 *
 * 绑定是有意显式的: 页面操作只作用于这里记录的标签页, 模型必须先 `tabs.activate`
 * 或 `tabs.open` 才能操作页面. 这样即使用户在别的标签页上手动操作, 模型也不会
 * 顺手改到那个页面.
 */
let boundTabId: number | null = null

/** 最近一次连接时的扩展 id, 供握手使用. */
const extensionId = chrome.runtime.id

/** 取当前绑定标签页; 没有绑定时抛出可自我纠正的错误. */
function requireBinding(): number {
  if (boundTabId === null) {
    throw new PageError('no-binding', '当前还没有绑定标签页. 请先调用 browser_tabs 看清单, 再用 browser_open 或 browser_select_tab 选中一个标签页.')
  }
  return boundTabId
}

/** 绑定失效时清理; 标签页被关掉后不该继续指向它. */
async function ensureBoundTabAlive(): Promise<number> {
  const tabId = requireBinding()
  try {
    await getTab(tabId)
    return tabId
  } catch {
    boundTabId = null
    throw new PageError('stale-target', `之前绑定的标签页 ${tabId} 已经关闭, 请重新列出并选择标签页.`)
  }
}

/**
 * 分派一次调用.
 * @param method 方法名.
 * @param args 参数.
 * @returns 方法返回值.
 */
async function dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'tabs.list':
      return listTabs()
    case 'tabs.activate': {
      const tabId = Number(args.tabId)
      const tab = await activateTab(tabId)
      boundTabId = tabId
      return tab
    }
    case 'tabs.open': {
      const tab = await openTab(String(args.url))
      boundTabId = tab.id
      return tab
    }
    case 'tabs.close': {
      const tabId = Number(args.tabId)
      await closeTab(tabId)
      if (boundTabId === tabId) boundTabId = null
      return { closed: true }
    }
    case 'page.snapshot':
      return snapshotPage(await ensureBoundTabAlive())
    case 'page.navigate': {
      const tabId = await ensureBoundTabAlive()
      const result = await navigateTab(tabId, String(args.url), 25_000)
      if (!result.completed) {
        // 加载没完成不算失败, 页面可能仍在跑脚本, 但要在结果里讲清楚.
        log('warn', `导航到 ${result.url} 未在 25s 内报告加载完成`)
      }
      return { url: result.url, title: result.title }
    }
    case 'page.click':
      return clickByIndex(await ensureBoundTabAlive(), String(args.token), Number(args.index))
    case 'page.fill':
      return fillByIndex(
        await ensureBoundTabAlive(),
        String(args.token),
        Number(args.index),
        String(args.text),
        args.submit === true,
      )
    case 'page.pressKey':
      return pressKeyInTab(await ensureBoundTabAlive(), String(args.key))
    case 'page.scroll':
      return scrollInTab(
        await ensureBoundTabAlive(),
        args.direction === 'up' ? 'up' : 'down',
        args.amount === undefined ? undefined : Number(args.amount),
      )
    case 'page.text':
      return readText(await ensureBoundTabAlive())
    case 'page.waitFor':
      return waitForText(await ensureBoundTabAlive(), String(args.text), Number(args.timeoutMs ?? 10_000))
    case 'page.query':
      return queryInTab(
        await ensureBoundTabAlive(),
        String(args.selector),
        Number(args.limit ?? 50),
        Number(args.maxChars ?? 200),
      )
    case 'page.hover':
      return hoverByIndex(await ensureBoundTabAlive(), String(args.token), Number(args.index))
    case 'page.uploadBegin':
      return uploadBeginInTab(
        await ensureBoundTabAlive(),
        String(args.name),
        String(args.mime),
        Number(args.bytes),
      )
    case 'page.uploadChunk':
      return uploadChunkInTab(await ensureBoundTabAlive(), String(args.uploadId), String(args.data))
    case 'page.uploadCommit':
      return uploadCommitInTab(
        await ensureBoundTabAlive(),
        String(args.selector),
        Number(args.nth ?? 0),
        args.uploadIds as string[],
      )
    case 'page.uploadAbort':
      return uploadAbortInTab(await ensureBoundTabAlive(), args.uploadIds as string[])
    case 'page.screenshot':
      return captureTab(await ensureBoundTabAlive(), args.format === 'jpeg' ? 'jpeg' : 'png')
    case 'page.evaluate':
      return evaluateInTab(
        await ensureBoundTabAlive(),
        String(args.expression),
        args.world === 'main' ? 'main' : 'isolated',
      )
    default:
      throw new PageError('internal', `未知方法 ${method}`)
  }
}

/** 把一次调用包成截止时间, 超时就回 timeout 而不是一直挂着. */
async function dispatchWithTimeout(frame: CallFrame): Promise<unknown> {
  const work = dispatch(frame.method, (frame.args ?? {}) as Record<string, unknown>)
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new PageError('timeout', `操作 ${frame.method} 超过 ${frame.timeoutMs}ms 仍未返回`))
    }, frame.timeoutMs)
  })
  return Promise.race([work, timeout])
}

/** 处理宿主帧. */
async function handleFrame(raw: unknown): Promise<void> {
  const frame = raw as Partial<CallFrame>
  if (frame.kind !== 'call') {
    log('warn', '收到无法识别的帧', raw)
    return
  }
  const id = Number(frame.id)
  const method = String(frame.method)
  if (!isBrowserMethod(method)) {
    bridge.send(errorFrame(id, 'internal', `不支持的调用 ${method}, 本扩展协议的版本可能和宿主不一致`))
    return
  }
  try {
    const value = await dispatchWithTimeout(frame as CallFrame)
    bridge.send(resultFrame(id, value))
  } catch (error) {
    if (error instanceof PageError) {
      bridge.send(errorFrame(id, error.code, error.message))
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    log('error', `调用 ${method} 失败`, error)
    bridge.send(errorFrame(id, 'internal', `扩展内部错误: ${message}`))
  }
}

/** 组装成功帧. */
function resultFrame(id: number, value: unknown): OutboundFrame {
  return { kind: 'result', id, ok: true, value }
}

/** 组装失败帧. */
function errorFrame(id: number, code: string, message: string): OutboundFrame {
  return { kind: 'error', id, ok: false, error: { code, message } }
}

/** 连接建立后补发握手, 让宿主确认对端身份与协议版本. */
function greet(): void {
  bridge.send({
    kind: 'event',
    event: 'hello',
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      extensionId,
      version: chrome.runtime.getManifest().version,
      boundTabId,
      userScripts: userScriptsAvailable(),
    },
  })
  // 绑定目标可能已经被关掉, 顺手清理一次, 免得宿主拿到过期编号.
  if (boundTabId !== null) {
    void getTab(boundTabId).catch(() => { boundTabId = null })
  }
}

const bridge = new NativeBridge(handleFrame, greet, log)

/**
 * 浏览器求值能力是否可用.
 *
 * 它取决于用户在扩展详情页手动打开的 "Allow User Scripts" 开关, 而不是扩展自己能决定的
 * 事. 所以把它报给宿主, 让配置页直接显示状态 —— 否则用户只会看到求值工具报一句"权限没
 * 打开", 还得自己去猜开关在哪.
 *
 * @returns 可用为 true.
 */
function userScriptsAvailable(): boolean {
  try {
    return (chrome as unknown as { userScripts?: unknown }).userScripts !== undefined
  } catch {
    return false
  }
}

/** 状态查询入口: popup 和宿主都可能问. */
function statusSnapshot(): BridgeStatus & { boundTabId: number | null, hostName: string, userScripts: boolean } {
  return { ...bridge.getStatus(), boundTabId, hostName: NATIVE_HOST_NAME, userScripts: userScriptsAvailable() }
}

// popup 每次打开会发一条 status 请求, 拿到当前连接与绑定状态.
chrome.runtime.onMessage.addListener((message: unknown, _sender, respond: (response: unknown) => void) => {
  const request = message as { kind?: string } | undefined
  if (request?.kind === 'status') {
    respond(statusSnapshot())
    return true
  }
  if (request?.kind === 'reconnect') {
    bridge.connect()
    respond(statusSnapshot())
    return false
  }
  return false
})

// 绑定标签页被关闭时立即清空绑定, 不等下一次调用才发现.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (boundTabId === tabId) {
    boundTabId = null
    bridge.send({ kind: 'event', event: 'detached', payload: { reason: 'bound-tab-closed' } })
  }
})

// 绑定的标签页地址变了就通知宿主: 快照 token 已经失效, 需要重新取快照.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === boundTabId && changeInfo.url !== undefined) {
    bridge.send({ kind: 'event', event: 'tab-changed', payload: { tabId, url: changeInfo.url } })
  }
})

log('info', `service worker 启动, 扩展 id=${extensionId}, 正在连接 native host ${NATIVE_HOST_NAME}`)
bridge.connect()
