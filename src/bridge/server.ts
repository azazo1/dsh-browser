/**
 * 宿主侧的桥: native host 连到这里, 调用在这里被派发给扩展.
 *
 * 鉴权分两层, 都不依赖浏览器 cookie (native host 是个普通 Node 进程, 拿不到 cookie):
 *
 *   1. Host 头必须是回环地址. 这一层挡的是 DNS rebinding: 页面把域名解析到
 *      127.0.0.1 之后, 浏览器发来的请求 Host 头会是那个域名而不是 127.0.0.1,
 *      于是被拒.
 *   2. 请求头里的令牌必须与会合文件里的一致. 网页读不到会合文件 (0600), 所以
 *      即使猜到端口也过不了这一层.
 *
 * 只保留最新的一条连接: 扩展的 service worker 重启会拉起新的 host 进程, 旧连接
 * 可能还挂着, 这时应当让新的胜出而不是两个同时在用.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
// 只为引入 webServer 服务的类型增强; 没有它 ctx.webServer 在类型上不存在.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer, WebSocket } from 'ws'
import { BRIDGE_PATH, DEFAULT_CALL_TIMEOUT_MS, PROTOCOL_VERSION } from '../../shared/protocol.js'
import type { ErrorFrame, HelloPayload, InboundFrame, OutboundFrame, ResultFrame } from '../../shared/protocol.js'
import type { BrowserMethod, MethodArgs, MethodResult } from '../../shared/methods.js'

/** 令牌所在的请求头名. */
const TOKEN_HEADER = 'x-dsh-bridge-token'

/** 扩展连接状态. */
export interface BridgeConnectionState {
  /** 是否有扩展连着. */
  connected: boolean
  /** 扩展的清单版本, 来自握手. */
  extensionVersion: string | null
  /** 扩展上报的当前绑定标签页. */
  boundTabId: number | null
  /** 最近一次断开或校验失败的原因. */
  lastError: string | null
}

/** 一次调用的失败; code 与协议里的错误类别一致, 便于工具层生成提示. */
export class BridgeCallError extends Error {
  /**
   * @param code 协议里的错误类别.
   * @param message 面向模型的中文说明.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BridgeCallError'
  }
}

/** 待配对的一次调用. */
interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/** 判断请求的 Host 头是否指向回环地址. */
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || host === '') return false
  // 允许 127.0.0.1:<port>、localhost:<port>、[::1]:<port>, 明确排除域名.
  const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? ''
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]'
}

/**
 * 桥服务: 注册升级路由, 管理连接, 派发调用.
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly pending = new Map<number, PendingCall>()
  private readonly listeners = new Set<(state: BridgeConnectionState) => void>()
  private live: WebSocket | null = null
  private nextId = 1
  private state: BridgeConnectionState = { connected: false, extensionVersion: null, boundTabId: null, lastError: null }

  /**
   * @param ctx 插件上下文, 用于挂升级路由.
   * @param token 本次运行的握手令牌.
   */
  constructor(private readonly ctx: Context, private readonly handshakeToken: string) {
    this.wss.on('connection', socket => { this.attach(socket) })
  }

  /** 本次运行的握手令牌; 由运行时写进会合文件供 native host 使用. */
  get token(): string {
    return this.handshakeToken
  }

  /** 当前连接状态快照. */
  get connectionState(): BridgeConnectionState {
    return { ...this.state }
  }

  /** 订阅连接状态变化; 返回取消订阅函数. */
  subscribe(listener: (state: BridgeConnectionState) => void): () => void {
    this.listeners.add(listener)
    listener(this.connectionState)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 注册升级路由.
   *
   * `webServer` 是本插件的必需依赖 (桥本身就是一条 HTTP 升级路由), 所以它在插件的
   * `inject` 里声明, 这里可以直接取用.
   *
   * @param ctx 插件上下文.
   * @param bridge 桥实例.
   */
  static mount(ctx: Context, bridge: BridgeServer): void {
    const webServer = ctx.webServer
    ctx.effect(() => webServer.registerUpgrade({
      path: BRIDGE_PATH,
      handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => { bridge.handleUpgrade(req, socket, head) },
    }), 'dsh-browser: bridge upgrade route')
  }

  /**
   * 调用扩展的一个方法.
   *
   * @param method 方法名.
   * @param args 方法参数.
   * @param options 取消信号与超时.
   * @returns 方法返回值.
   */
  call<M extends BrowserMethod>(
    method: M,
    args: MethodArgs<M>,
    options: { signal?: AbortSignal, timeoutMs?: number } = {},
  ): Promise<MethodResult<M>> {
    const socket = this.live
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeCallError(
        'no-binding',
        '扩展当前没有连着 dsh. 请在 chrome://extensions 确认 dsh Browser 已启用, 并点开它的图标看连接状态.',
      ))
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const id = this.nextId
    this.nextId += 1
    const frame: InboundFrame = { kind: 'call', id, method, args, timeoutMs }
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeCallError('timeout', `扩展在 ${String(timeoutMs)}ms 内没有回应 ${method}`))
      }, timeoutMs + 1_000)
      const onAbort = (): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new BridgeCallError('internal', '调用已被取消'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          resolve(value as MethodResult<M>)
        },
        reject: (error: unknown) => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      try {
        socket.send(JSON.stringify(frame))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new BridgeCallError('internal', `发送调用失败: ${String(error)}`))
      }
    })
  }

  /** 关闭桥并拒绝所有在途调用. */
  dispose(): void {
    this.failAll(new BridgeCallError('internal', '插件正在卸载, 调用已中断'))
    this.live?.close(1001, 'plugin unloaded')
    this.live = null
    this.wss.close()
  }

  /** 处理一次升级请求: 先鉴权, 再交给 ws. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, reason: string): void => {
      socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    if (!isLoopbackHost(req)) {
      this.note('拒绝非回环 Host 的桥连接请求 (可能是 DNS rebinding 尝试)')
      reject(403, 'Forbidden')
      return
    }
    const provided = req.headers[TOKEN_HEADER]
    if (typeof provided !== 'string' || !timingSafeEqual(provided, this.handshakeToken)) {
      this.note('拒绝令牌不匹配的桥连接请求')
      reject(401, 'Unauthorized')
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
    })
  }

  /** 接管一条新连接, 并让旧连接让位. */
  private attach(socket: WebSocket): void {
    const previous = this.live
    this.live = socket
    if (previous !== null && previous !== socket) {
      this.note('有新的 native host 连接上来, 关闭之前那条')
      previous.close(1000, 'superseded')
    }
    this.setState({ connected: true, lastError: null })

    socket.on('message', (data) => {
      let frame: OutboundFrame
      try {
        frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) as OutboundFrame
      } catch (error) {
        this.note(`收到无法解析的帧: ${String(error)}`)
        return
      }
      this.handleFrame(frame)
    })
    socket.on('close', () => {
      if (this.live === socket) this.live = null
      this.setState({ connected: false, extensionVersion: null, boundTabId: null })
      this.failAll(new BridgeCallError('internal', '扩展断开了连接, 在途调用已中断'))
    })
    socket.on('error', (error) => {
      this.note(`桥连接出错: ${String(error)}`)
    })
  }

  /** 处理来自扩展的一帧. */
  private handleFrame(frame: OutboundFrame): void {
    if (frame.kind === 'result') {
      const result = frame as ResultFrame
      const pending = this.pending.get(result.id)
      if (pending === undefined) return
      this.pending.delete(result.id)
      pending.resolve(result.value)
      return
    }
    if (frame.kind === 'error') {
      const failure = frame as ErrorFrame
      const pending = this.pending.get(failure.id)
      if (pending === undefined) return
      this.pending.delete(failure.id)
      pending.reject(new BridgeCallError(failure.error.code, failure.error.message))
      return
    }
    if (frame.kind === 'event') {
      if (frame.event === 'hello') {
        const hello = frame.payload as Partial<HelloPayload>
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          this.note(`扩展的协议版本 ${String(hello.protocolVersion)} 与本插件 ${String(PROTOCOL_VERSION)} 不一致, 请重新加载扩展`)
        }
        this.setState({
          connected: true,
          extensionVersion: typeof hello.version === 'string' ? hello.version : null,
          boundTabId: typeof hello.boundTabId === 'number' ? hello.boundTabId : null,
        })
      }
      if (frame.event === 'tab-changed' || frame.event === 'detached') {
        const payload = frame.payload as { tabId?: number }
        this.setState({
          boundTabId: frame.event === 'detached' ? null : (payload.tabId ?? null),
        })
      }
    }
  }

  /** 记录一次异常并更新状态. */
  private note(message: string): void {
    this.ctx.logger.warn(`dsh-browser: ${message}`)
    this.setState({ lastError: message })
  }

  /** 更新状态并通知订阅者. */
  private setState(patch: Partial<BridgeConnectionState>): void {
    this.state = { ...this.state, ...patch }
    const snapshot = this.connectionState
    for (const listener of this.listeners) listener(snapshot)
  }

  /** 拒绝所有在途调用. */
  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}

/** 常数时间比较, 避免用比较耗时反推令牌. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
