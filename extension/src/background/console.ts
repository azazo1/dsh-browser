/**
 * console 抓取: chrome.debugger 按需 attach + CDP Runtime domain.
 *
 * 抓取是**显式开关的**: start 时 attach 并 `Runtime.enable`, stop 时 detach. 只开
 * `Runtime` domain 收 `consoleAPICalled` 与 `exceptionThrown`, 绝不碰 `Debugger`
 * domain —— 后者会让页面里的反调试代码 (`debugger;` 语句) 真的暂停执行.
 *
 * attach 的副作用是浏览器顶部出现"已开始调试此浏览器"提示条: 它是浏览器 UI 而不是
 * 页面内容, 页面 JS 读不到, 也不设置 `navigator.webdriver`, 所以网页层面基本检测不到.
 * 用户可以点提示条上的"取消"强制 detach, 这会被 `onDetach` 捕获并报告成中断原因, 而不是
 * 静默丢数据.
 *
 * 状态持久化在 `chrome.storage.session`: MV3 service worker 可能被随时回收, 重启后从
 * storage 恢复缓冲与抓取状态, 并校验 attachment 是否还活着; 缓冲里的条目不会因为 SW
 * 重启而丢失. 浏览器重启才会真正清空.
 */

import type { ConsoleEntry, ConsoleReadResult } from '../../../shared/methods.js'
import { MAX_CONSOLE_READ_WAIT_MS } from '../../../shared/protocol.js'
import { PageError } from './errors.js'

/** 环形缓冲上限; 超过就淘汰最旧的条目, 防止高噪声页面撑爆内存与 storage. */
const MAX_ENTRIES = 1000

/** 单条条目的文本上限; 单条超长的输出 (如大对象 dump) 截断而不是撑爆整个缓冲. */
const MAX_ENTRY_CHARS = 2000

/** read 长轮询的检查间隔. */
const READ_POLL_INTERVAL_MS = 200

/** storage.session 里的键名. */
const STORAGE_KEY = 'consoleCapture'

// ---------------------------------------------------------------------------
// CDP 类型: 只声明用到的字段.
// ---------------------------------------------------------------------------

/** CDP `Runtime.RemoteObject` 的子集. */
export interface CdpRemoteObject {
  type: string
  value?: unknown
  description?: string
  unserializableValue?: string
  preview?: {
    type: string
    description?: string
    overflow?: boolean
    properties?: { name: string, type?: string, value?: string, subtype?: string }[]
  }
}

/** CDP 调用栈帧的子集; 0 基行号. */
export interface CdpStackFrame {
  url?: string
  lineNumber?: number
  columnNumber?: number
}

/** CDP `Runtime.consoleAPICalled` 的 params 子集. */
export interface CdpConsoleApiCalled {
  type: string
  args: CdpRemoteObject[]
  stackTrace?: CdpStackFrame[]
  timestamp?: number
}

/** CDP `Runtime.exceptionThrown` 的 params 子集. */
export interface CdpExceptionThrown {
  timestamp?: number
  exceptionDetails?: {
    text?: string
    url?: string
    lineNumber?: number
    columnNumber?: number
    exception?: { description?: string, value?: unknown }
  }
}

// ---------------------------------------------------------------------------
// 纯函数: CDP 事件到条目的映射 (无 chrome 依赖, 可直接测试).
// ---------------------------------------------------------------------------

/**
 * 把一个 RemoteObject 转成可读文本.
 *
 * 优先 `preview` (对象/数组的摘要, DevTools 折叠面板里那份), 其次原始 `value`,
 * 再 `description` (函数/类/复杂对象), 最后 `unserializableValue`. 字符串值带引号,
 * 与浏览器 console 的展示习惯一致.
 *
 * @param obj CDP RemoteObject.
 * @returns 可读文本.
 */
export function formatRemoteObject(obj: CdpRemoteObject): string {
  const preview = obj.preview
  if (preview !== undefined) {
    const items = (preview.properties ?? [])
      .map(property => `${property.name}: ${property.value ?? formatRemoteObjectEmpty(property)}`)
    const body = items.join(', ') + (preview.overflow === true ? ', …' : '')
    const open = preview.type === 'array' ? '[' : '{'
    const close = preview.type === 'array' ? ']' : '}'
    return `${open}${body}${close}`
  }
  if (obj.type === 'string') return JSON.stringify(obj.value)
  if (obj.value !== undefined) return String(obj.value)
  if (obj.unserializableValue !== undefined) return obj.unserializableValue
  if (obj.description !== undefined) return obj.description
  return `[${obj.type}]`
}

/** preview 属性缺 value 字段时的兜底 (嵌套对象被截断时只有 type/subtype). */
function formatRemoteObjectEmpty(property: { type?: string, subtype?: string }): string {
  if (property.subtype !== undefined) return `<${property.subtype}>`
  if (property.type !== undefined) return `<${property.type}>`
  return '<…>'
}

/**
 * 把一次 console API 调用映射成条目.
 *
 * @param seq 会话内序号.
 * @param params CDP params.
 * @returns 条目.
 */
export function mapConsoleApiCalled(seq: number, params: CdpConsoleApiCalled): ConsoleEntry {
  const frame = params.stackTrace?.[0]
  const text = truncateText((params.args ?? []).map(formatRemoteObject).join(' '))
  return {
    seq,
    level: levelOfType(params.type),
    type: params.type,
    text,
    url: frame?.url ? frame.url : null,
    line: typeof frame?.lineNumber === 'number' ? frame.lineNumber + 1 : null,
    timestamp: params.timestamp ?? Date.now(),
  }
}

/**
 * 把一次未捕获异常映射成条目.
 *
 * @param seq 会话内序号.
 * @param params CDP params.
 * @returns 条目.
 */
export function mapExceptionThrown(seq: number, params: CdpExceptionThrown): ConsoleEntry {
  const details = params.exceptionDetails ?? {}
  const text = details.exception?.description
    ?? (details.exception?.value !== undefined ? String(details.exception.value) : (details.text ?? 'Unknown error'))
  return {
    seq,
    level: 'error',
    type: 'exception',
    text: truncateText(text),
    url: details.url ? details.url : null,
    line: typeof details.lineNumber === 'number' ? details.lineNumber + 1 : null,
    timestamp: params.timestamp ?? Date.now(),
  }
}

/** CDP 的 console API type 到归一化级别; assert 失败按错误算, 展示类命令归入 other. */
function levelOfType(type: string): ConsoleEntry['level'] {
  switch (type) {
    case 'log': return 'log'
    case 'info': return 'info'
    case 'warning': return 'warning'
    case 'error':
    case 'assert': return 'error'
    case 'debug': return 'debug'
    default: return 'other'
  }
}

function truncateText(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…` : text
}

/** 把 onDetach 的原因翻成给模型看的话. */
export function describeDetachReason(reason: string): string {
  switch (reason) {
    case 'canceled_by_user': return '用户点掉了"已开始调试此浏览器"提示条'
    case 'target_closed': return '目标标签页已关闭'
    case 'browser_forced': return '浏览器强制分离了调试器'
    case 'injection_failed': return '调试器注入失败'
    case 'permission_denied': return '调试权限被拒绝'
    default: return `浏览器分离了调试器 (${reason})`
  }
}

// ---------------------------------------------------------------------------
// 状态管理: 缓冲, 持久化, SW 重启恢复.
// ---------------------------------------------------------------------------

/** 持久化的抓取状态. */
interface CaptureState {
  /** 正在抓取的标签页; capturing 为 true 时必有值. */
  tabId: number | null
  capturing: boolean
  /** 最近发出的条目序号. */
  seq: number
  entries: ConsoleEntry[]
  interrupted: string | null
}

/** 模块级状态; 首次使用时从 storage.session 恢复. */
let state: CaptureState | null = null
/** ensureLoaded 是否已经执行过 (包括"storage 里什么都没有"的结果). */
let loaded = false
/** 主动 detach 时置位, 防止 onDetach 把 stop 误报成中断. */
let intentionalDetach = false
/** 串行化 storage 写入, 避免并发写互相覆盖. */
let persistChain: Promise<void> = Promise.resolve()

/**
 * 从 storage.session 恢复状态 (幂等).
 *
 * SW 重启后状态存在但 attachment 可能已经丢了 (onDetach 事件在 SW 死亡期间发生过), 用
 * 一个最便宜的命令探活; 探活失败就标记中断, 条目保留 —— 数据不丢, 只是不会再有新的.
 */
export async function restoreConsoleCapture(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY)
    const restored = stored[STORAGE_KEY] as CaptureState | undefined
    state = restored ?? null
  } catch {
    state = null
  }
  if (state?.capturing === true && state.tabId !== null) {
    try {
      await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Runtime.evaluate', { expression: '1' })
    } catch {
      state.capturing = false
      state.interrupted ??= '扩展后台被重启, 调试器连接已丢失'
      void persistState()
    }
  }
}

/** 当前是否在抓取; 供 hello 与状态查询使用 (先 restoreConsoleCapture). */
export function consoleCaptureStatus(): { tabId: number } | null {
  return state?.capturing === true && state.tabId !== null ? { tabId: state.tabId } : null
}

function persistState(): Promise<void> {
  const chain = persistChain.then(async () => {
    if (state === null) await chrome.storage.session.remove(STORAGE_KEY)
    else await chrome.storage.session.set({ [STORAGE_KEY]: state })
  })
  // 写失败不该打断主流程: storage 满了之类的情况下内存里的缓冲仍然可用, 只是 SW 重启后
  // 会丢. 这里吞掉异常并继续串行队列.
  persistChain = chain.catch(() => undefined)
  return chain
}

/** 追加条目并淘汰最旧; seq 由调用方维护在 state 上. */
function appendEntry(entry: ConsoleEntry): void {
  if (state === null) return
  state.seq = Math.max(state.seq, entry.seq)
  state.entries.push(entry)
  if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES)
  void persistState()
}

async function detachQuietly(tabId: number): Promise<void> {
  intentionalDetach = true
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // 已经分离 (或从未成功 attach) 不算失败.
    intentionalDetach = false
  }
}

// ---------------------------------------------------------------------------
// chrome.debugger 事件.
// ---------------------------------------------------------------------------

/**
 * 注册 debugger 事件监听; 由 index.ts 在 SW 启动时调用.
 *
 * 单独成函数而不是模块顶层直接注册: 测试环境里 import 本模块时 chrome 还是桩, 顶层注册
 * 要么报错要么把测试桩的监听器路径搞乱; 显式安装让测试也能自由控制时机.
 */
export function installConsoleListeners(): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    void handleDebuggerEvent(source as { tabId?: number }, method, params)
  })
  chrome.debugger.onDetach.addListener((source, reason) => {
    handleDetach(source as { tabId?: number }, String(reason))
  })
}

async function handleDebuggerEvent(source: { tabId?: number }, method: string, params: unknown): Promise<void> {
  if (!loaded) await restoreConsoleCapture()
  if (state === null || !state.capturing || source.tabId !== state.tabId) return
  if (method === 'Runtime.consoleAPICalled') {
    appendEntry(mapConsoleApiCalled(state.seq + 1, params as CdpConsoleApiCalled))
    return
  }
  if (method === 'Runtime.exceptionThrown') {
    appendEntry(mapExceptionThrown(state.seq + 1, params as CdpExceptionThrown))
  }
}

function handleDetach(source: { tabId?: number }, reason: string): void {
  if (intentionalDetach) {
    intentionalDetach = false
    return
  }
  if (state === null || !state.capturing || source.tabId !== state.tabId) return
  state.capturing = false
  state.interrupted = describeDetachReason(reason)
  void persistState()
}

// ---------------------------------------------------------------------------
// 协议方法.
// ---------------------------------------------------------------------------

/**
 * 开始抓取指定标签页的 console.
 *
 * @param tabId 目标标签页.
 * @returns 结果说明.
 * @throws PageError 内部页面不允许 attach, 或 attach/Runtime.enable 失败.
 */
export async function startCapture(tabId: number): Promise<{ tabId: number, note: string }> {
  await restoreConsoleCapture()
  // 抓取是全局单例: 换目标时旧的让位 (旧缓冲一并丢弃, 只保证新会话从零开始).
  if (state?.capturing === true && state.tabId !== null && state.tabId !== tabId) {
    await detachQuietly(state.tabId)
  }
  if (state?.capturing === true && state.tabId === tabId) {
    state.entries = []
    state.interrupted = null
    // Runtime.enable 幂等, 重复调用无害; 顺带确认 attachment 还活着.
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
    void persistState()
    return { tabId, note: '该标签页已经在抓取, 缓冲已清空, 从现在开始重新收集.' }
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/cannot attach/i.test(message)) {
      throw new PageError(
        'injection-blocked',
        `无法对标签页 ${String(tabId)} 开启 console 抓取: Chrome 不允许在这个页面上使用调试器, `
        + '常见于 chrome:// 等内部页面. 请换一个普通网页.',
      )
    }
    throw new PageError('internal', `对标签页 ${String(tabId)} 附加调试器失败: ${message}`)
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
  } catch (error) {
    await detachQuietly(tabId)
    const message = error instanceof Error ? error.message : String(error)
    throw new PageError('internal', `开启 Runtime 域失败, 已放弃抓取: ${message}`)
  }
  state = { tabId, capturing: true, seq: 0, entries: [], interrupted: null }
  void persistState()
  return {
    tabId,
    note: '已开始抓取 console (只收集从现在开始的输出, 不含历史). '
      + '浏览器顶部会出现"已开始调试此浏览器"提示条, 属正常现象, 页面检测不到; '
      + '完成收集后请用 action:"stop" 结束, 提示条随之消失.',
  }
}

/**
 * 读取自上次读取以来的条目 (drain), 可选长轮询等新条目.
 *
 * @param waitMs 缓冲为空时最多再等多久 (毫秒); 0 表示立即返回.
 * @returns 结果.
 * @throws PageError 从未开始过抓取时.
 */
export async function readEntries(waitMs: number): Promise<ConsoleReadResult> {
  await restoreConsoleCapture()
  if (state === null) {
    throw new PageError(
      'internal',
      '当前没有 console 抓取会话. 请先用 action:"start" 开始抓取, 再执行想观察的页面操作.',
    )
  }
  const deadline = Date.now() + waitMs
  while (state.entries.length === 0 && state.capturing && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, READ_POLL_INTERVAL_MS))
  }
  const entries = state.entries
  state.entries = []
  const capturing = state.capturing
  const interrupted = state.interrupted
  void persistState()
  const note = buildReadNote(entries.length, capturing, interrupted, waitMs)
  return { entries, capturing, interrupted, note }
}

function buildReadNote(count: number, capturing: boolean, interrupted: string | null, waitMs: number): string {
  const parts = [`返回 ${String(count)} 条`]
  if (capturing) {
    parts.push('抓取仍在进行')
    if (count === 0 && waitMs > 0) parts.push(`已等待 ${String(waitMs)}ms 仍没有新输出`)
    else if (count === 0) parts.push('期间没有新输出; 可以把操作再执行一遍后带上 wait_ms 重读, 或直接 stop 结束')
  } else if (interrupted !== null) {
    parts.push(`抓取已中断 (${interrupted}); 缓冲里的条目仍可读, 需要继续请重新 action:"start"`)
  } else {
    parts.push('抓取已停止')
  }
  return parts.join('; ')
}

/**
 * 停止抓取并返回最后一批条目.
 *
 * @returns 结果.
 */
export async function stopCapture(): Promise<ConsoleReadResult> {
  await restoreConsoleCapture()
  if (state === null) {
    return { entries: [], capturing: false, interrupted: null, note: '没有正在进行的 console 抓取.' }
  }
  if (state.capturing && state.tabId !== null) await detachQuietly(state.tabId)
  state.capturing = false
  state.interrupted = null
  const entries = state.entries
  state.entries = []
  void persistState()
  return { entries, capturing: false, interrupted: null, note: `已停止抓取, 返回最后 ${String(entries.length)} 条.` }
}
