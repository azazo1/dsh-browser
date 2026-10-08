/**
 * native messaging host.
 *
 * 这个进程由 Chrome 启动 (不是由 dsh 启动), 它在两条通道之间搬运字节:
 *
 *   扩展 <-> 本进程     Chrome native messaging: stdin/stdout, 4 字节小端长度前缀 + JSON
 *   本进程 <-> dsh      回环 WebSocket: 从会合文件读地址与令牌
 *
 * 两条硬约束:
 *
 *   1. **stdout 只允许出现 native messaging 帧.** 任何多余的输出 (包括调试打印)
 *      都会被 Chrome 当成协议数据, 直接破坏整条通道. 因此本文件里所有日志一律走
 *      stderr, 且不允许使用 console.log.
 *
 *   2. **被 Chrome 直接 exec, 不经过 shell.** 所以本文件不能依赖 PATH 里的解释器,
 *      它由旁边的包装脚本用绝对解释器路径拉起, 见 install.ts 里的说明.
 *
 * 被 Chrome 启动后, 会合文件可能还不存在 (dsh 还没起来), 或者 dsh 之后才启动,
 * 所以连接失败要退避重试而不是退出: 进程活着, 扩展就能一直连上这条通道.
 */

import { WebSocket } from 'ws'
import { readFile } from 'node:fs/promises'

/** 会合文件的字段; 由 dsh 侧写入. */
interface Rendezvous {
  /** 宿主 WebSocket 地址, 例如 ws://127.0.0.1:19387/ext/bridge. */
  wsUrl: string
  /** 握手令牌; 会合文件本身只有本用户可读, 令牌是第二道校验. */
  token: string
}

/** 重连退避 (毫秒); 用完后停在这个节奏上一直重试. */
const BACKOFF_MS = [200, 500, 1_000, 2_000, 5_000, 10_000]

/** 出站队列上限: 超过就断开 NM 通道, 让扩展重新连, 避免静默堆积. */
const MAX_QUEUE = 128

/** 单条 native messaging 消息的上限, 与 Chrome 的约定保持一致. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** 日志一律走 stderr; stdout 是协议专用. */
function log(message: string): void {
  process.stderr.write(`[dsh-browser nm-host pid=${String(process.pid)}] ${message}\n`)
}

/** 会合文件路径由启动参数给出, 避免这里再算一遍路径规则. */
function rendezvousPath(): string {
  const fromArgv = process.argv[2]
  if (fromArgv !== undefined && fromArgv !== '') return fromArgv
  const fromEnv = process.env['DSH_BROWSER_RENDEZVOUS']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  throw new Error('缺少会合文件路径: 应由 native messaging 清单的启动包装脚本以第一个参数传入')
}

/** 读会合文件; 不存在或内容不完整时返回 null (dsh 可能还没就绪). */
async function readRendezvous(): Promise<Rendezvous | null> {
  let text: string
  try {
    text = await readFile(rendezvousPath(), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as Partial<Rendezvous>
    if (typeof parsed.wsUrl !== 'string' || typeof parsed.token !== 'string') return null
    if (parsed.wsUrl === '' || parsed.token === '') return null
    return { wsUrl: parsed.wsUrl, token: parsed.token }
  } catch {
    return null
  }
}

/** 把一帧写到 stdout, 带上 native messaging 要求的长度前缀. */
function writeFrame(value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(payload.length, 0)
  process.stdout.write(header)
  process.stdout.write(payload)
}

/** 从 stdin 读长度前缀帧, 每帧交给回调. */
class StdinFramer {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * @param onFrame 收到完整一帧时的回调.
   * @param onEnd stdin 结束 (Chrome 关掉了通道) 时的回调.
   */
  constructor(private readonly onFrame: (frame: unknown) => void, private readonly onEnd: () => void) {}

  /** 接一段数据. */
  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 4) return
      const length = this.buffer.readUInt32LE(0)
      if (length > MAX_FRAME_BYTES) {
        log(`stdin 帧长度 ${String(length)} 超出上限, 关闭通道`)
        this.onEnd()
        return
      }
      if (this.buffer.length < 4 + length) return
      const payload = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      try {
        this.onFrame(JSON.parse(payload.toString('utf8')))
      } catch (error) {
        log(`stdin 帧不是合法 JSON, 已丢弃: ${String(error)}`)
      }
    }
  }
}

/** 出站队列: dsh 没连上时先攒着, 连上后按序补发. */
const outbound: unknown[] = []
let socket: WebSocket | null = null
let closing = false

/** 向 dsh 发一帧; 还没连上就排队. */
function toHost(frame: unknown): void {
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame))
    return
  }
  if (outbound.length >= MAX_QUEUE) {
    log(`出站队列已满 (${String(outbound.length)}), 关闭 native 通道让扩展重连`)
    closing = true
    process.exit(0)
  }
  outbound.push(frame)
}

/** 连上 dsh 之前先攒着的帧, 连上后一次性补发. */
function flush(): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return
  while (outbound.length > 0) {
    const frame = outbound.shift()
    socket.send(JSON.stringify(frame))
  }
}

/** 一次连接尝试的结束原因. */
type AttemptOutcome = 'connected-then-closed' | 'no-rendezvous' | 'failed'

/**
 * 尝试连接 dsh 并持续搬运, 直到连接结束.
 * @returns 本次尝试的结束原因, 用于决定退避策略.
 */
async function attempt(): Promise<AttemptOutcome> {
  const rendezvous = await readRendezvous()
  if (rendezvous === null) return 'no-rendezvous'

  return new Promise<AttemptOutcome>((resolve) => {
    let settled = false
    let opened = false
    const finish = (outcome: AttemptOutcome): void => {
      if (settled) return
      settled = true
      socket = null
      resolve(outcome)
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(rendezvous.wsUrl, {
        headers: { 'x-dsh-bridge-token': rendezvous.token },
      })
    } catch (error) {
      log(`创建 WebSocket 失败: ${String(error)}`)
      finish('failed')
      return
    }
    socket = ws

    ws.on('open', () => {
      opened = true
      log(`已连上 dsh: ${rendezvous.wsUrl}`)
      // 告诉扩展"我到 dsh 了". 这是扩展唯一能得知真实链路状态的消息 ——
      // 它自己的 connectNative 只证明 host 进程起来了, 不证明 host 连上了 dsh.
      writeFrame({ kind: 'event', event: 'link-ready', payload: { wsUrl: rendezvous.wsUrl } })
      flush()
    })
    ws.on('message', (data) => {
      // 从 dsh 来的帧原样转给扩展; dsh 侧已经保证是合法 JSON.
      try {
        writeFrame(JSON.parse(typeof data === 'string' ? data : data.toString('utf8')))
      } catch (error) {
        log(`来自 dsh 的帧不是合法 JSON, 已丢弃: ${String(error)}`)
      }
    })
    ws.on('error', (error) => {
      log(`WebSocket 错误: ${String(error)}`)
    })
    ws.on('close', () => {
      // 已经建立过连接才需要通知; 首次就没连上时不打扰扩展.
      if (opened) {
        writeFrame({ kind: 'event', event: 'link-lost', payload: { reason: 'dsh 侧连接已断开' } })
        log('与 dsh 的连接已断开, 将重试')
      }
      finish(opened ? 'connected-then-closed' : 'failed')
    })
  })
}

/** 主循环: 一直重连, 直到 stdin 结束. */
async function main(): Promise<void> {
  const framer = new StdinFramer(toHost, () => {
    // Chrome 关掉 stdin 表示扩展侧已经断开, 本进程应当退出.
    closing = true
    process.exit(0)
  })
  process.stdin.on('data', (chunk: Buffer) => { framer.push(chunk) })
  process.stdin.on('end', () => { closing = true; process.exit(0) })
  process.stdin.resume()

  log(`启动, 会合文件 ${rendezvousPath()}`)

  let index = 0
  for (;;) {
    if (closing) return
    const outcome = await attempt()
    if (closing) return
    if (outcome === 'connected-then-closed') {
      // 曾经连上过, 说明配置是对的, 大概率只是 dsh 重启, 从最短间隔重试.
      index = 0
    } else {
      index += 1
      if (index === 1) {
        log(outcome === 'no-rendezvous'
          ? '会合文件还不存在, 说明 dsh 侧还没就绪, 继续等待'
          : '连接 dsh 失败, 继续重试')
      }
    }
    const delay = BACKOFF_MS[Math.min(index, BACKOFF_MS.length - 1)]
    await new Promise(resolve => setTimeout(resolve, delay))
  }
}

void main().catch((error: unknown) => {
  log(`致命错误: ${String(error)}`)
  process.exit(1)
})
