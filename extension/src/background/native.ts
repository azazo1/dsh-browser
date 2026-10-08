/**
 * 扩展侧的 native messaging 连接管理.
 *
 * 这里换掉了旧方案里"扩展去猜端口"的做法: 扩展完全不接触任何端口, 只调用
 * `chrome.runtime.connectNative`. Chrome 会按 native messaging 清单去启动宿主
 * 进程并建立管道, 通道由 Chrome 建立, 因此 dsh 的 web 端口是多少都无所谓.
 *
 * 两个附带好处:
 *   - 没有回环端口暴露, 网页无法扫到这个通道.
 *   - 打开的 native port 会让 MV3 service worker 保持存活, 不需要靠 alarms 反复唤醒.
 *
 * 失败时用退避重连, 并用一个 alarm 兜底: 如果 service worker 因为别的原因被回收,
 * alarm 会把它叫醒再试一次.
 */

import { NATIVE_HOST_NAME, PROTOCOL_VERSION } from '../../../shared/protocol.js'
import type { OutboundFrame } from '../../../shared/protocol.js'

/** 重连 alarm 名; MV3 的 alarm 周期下限是 30 秒. */
const RECONNECT_ALARM = 'dsh-browser-reconnect'

/** 退避序列 (毫秒); 用完后固定在最后一个值上. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 15_000, 30_000]

/**
 * 连接状态, 供 popup 展示.
 *
 * `hostConnected` 与 `linked` 必须分开: 前者是"host 进程起来了"(扩展自己就能知道),
 * 后者是"host 已连上 dsh"(只有 host 能告诉我们). 只显示前者会误导 —— 用户会以为整条
 * 链路通了, 而实际上 dsh 那边什么都没收到.
 */
export interface BridgeStatus {
  /** 是否已连上 native host (stdio 通道建立). */
  hostConnected: boolean
  /** 是否已确认打通到 dsh. 仅由 host 的 link-ready / link-lost 事件驱动. */
  linked: boolean
  /** 最近一次失败原因; 正常时清空. */
  lastError: string | null
  /** 已重连次数, 仅用于诊断. */
  attempts: number
}

type StatusListener = (status: BridgeStatus) => void

/** 管理唯一的 native port, 并把收到的帧交给回调. */
export class NativeBridge {
  private port: chrome.runtime.Port | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private backoffIndex = 0
  private status: BridgeStatus = { hostConnected: false, linked: false, lastError: null, attempts: 0 }
  private readonly listeners = new Set<StatusListener>()

  /**
   * @param onFrame 收到宿主帧时的回调; 返回的 Promise 表示处理完成.
   * @param onConnected 连接建立后回调, 用于补发握手.
   */
  constructor(
    private readonly onFrame: (frame: unknown) => Promise<void>,
    private readonly onConnected: () => void,
    private readonly log: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void,
  ) {
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === RECONNECT_ALARM && this.port === null) this.connect()
    })
    chrome.runtime.onStartup.addListener(() => { this.connect() })
    chrome.runtime.onInstalled.addListener(() => { this.connect() })
  }

  /** 当前状态快照. */
  getStatus(): BridgeStatus {
    return { ...this.status }
  }

  /** 订阅状态变化, 返回取消订阅函数. */
  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    listener(this.getStatus())
    return () => { this.listeners.delete(listener) }
  }

  /** 发起一次连接; 已经连着时是空操作. */
  connect(): void {
    if (this.port !== null) return
    this.clearTimer()
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    } catch (error) {
      // connectNative 在清单缺失时直接抛错, 这是最常见的失败原因, 单独给出提示.
      this.fail(`无法连接 native host "${NATIVE_HOST_NAME}": ${String(error)}. 通常是 native messaging 清单还没装好, 请在 dsh 的插件配置页点"安装连接组件".`)
      return
    }
    this.port = port
    port.onMessage.addListener((message: unknown) => {
      // 链路状态事件由 host 发出, 在这里先消化掉: 它不属于业务帧, 不该转给调用方.
      const frame = message as { kind?: string, event?: string, payload?: { reason?: string } }
      if (frame?.kind === 'event' && frame.event === 'link-ready') {
        this.status = { ...this.status, linked: true, lastError: null }
        this.emit()
        this.log('info', 'native host 已连上 dsh')
        // 立刻重新握手: dsh 可能是刚重启的 (端口和令牌都换了), 新的一侧还不知道我们的
        // 存在. 不补这一次握手, 宿主侧就只会看到"通道通了"却拿不到扩展版本与已绑定的
        // 标签页, 状态面板显示不全.
        this.onConnected()
        return
      }
      if (frame?.kind === 'event' && frame.event === 'link-lost') {
        this.status = { ...this.status, linked: false, lastError: frame.payload?.reason ?? 'dsh 侧连接已断开' }
        this.emit()
        return
      }
      void this.onFrame(message).catch((error: unknown) => {
        this.log('error', '处理宿主帧时出错', error)
      })
    })
    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message ?? '宿主进程已断开'
      this.port = null
      this.fail(`与宿主的连接断开: ${detail}`)
    })
    // 连上 host 不等于连上 dsh; linked 要等 host 报 link-ready.
    this.status = { ...this.status, hostConnected: true, linked: false, lastError: null }
    this.backoffIndex = 0
    this.emit()
    this.log('info', `已连接 native host ${NATIVE_HOST_NAME}`)
    this.onConnected()
  }

  /** 主动断开; 用于调试或用户禁用. */
  disconnect(): void {
    this.clearTimer()
    const port = this.port
    this.port = null
    if (port !== null) {
      try {
        port.disconnect()
      } catch {
        // 断开已经断掉的 port 会抛错, 忽略即可.
      }
    }
    this.status = { ...this.status, hostConnected: false, linked: false, lastError: null }
    this.emit()
  }

  /**
   * 向宿主发送一帧.
   * @param frame 要发送的帧.
   * @returns 是否成功送出; false 表示当前没连接.
   */
  send(frame: OutboundFrame): boolean {
    if (this.port === null) return false
    try {
      this.port.postMessage(frame)
      return true
    } catch (error) {
      this.fail(`发送失败: ${String(error)}`)
      return false
    }
  }

  /** 记录一次失败并安排重连. */
  private fail(message: string): void {
    this.status = { ...this.status, hostConnected: false, linked: false, lastError: message, attempts: this.status.attempts + 1 }
    this.emit()
    this.log('warn', message)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.timer !== null) return
    const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)]
    this.backoffIndex += 1
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private emit(): void {
    const snapshot = this.getStatus()
    for (const listener of this.listeners) listener(snapshot)
  }
}

/** 当前协议版本, 供握手使用. */
export const CURRENT_PROTOCOL_VERSION = PROTOCOL_VERSION

/** native host 名, 供 popup 展示排查信息. */
export const HOST_NAME = NATIVE_HOST_NAME
