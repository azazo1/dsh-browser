/**
 * 配对令牌的校验.
 *
 * 这是鉴权的核心: 握手时 dsh 核对扩展报上来的令牌, 不一致就拒绝这条连接. 所以这里用真实的
 * `BridgeServer` 加一个真的 WebSocket 客户端角色, 把四种情况都走一遍:
 *
 *   1. dsh 还没配置令牌 -> 拒绝, 而且原因是"去抄令牌";
 *   2. 扩展没报令牌 -> 拒绝;
 *   3. 令牌不一致 -> 拒绝;
 *   4. 一致 -> 接受, 并把配对错误清掉.
 *
 * 拒绝时必须**把原因送回扩展**: 只关连接的话, 用户看到的只是"连不上", 完全不知道下一步要填
 * 令牌 —— 这条也一并断言.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { BridgeServer } from '../src/bridge/server.ts'

/** 一个起在回环端口上的桥, 以及连它的辅助函数. */
interface Harness {
  port: number
  bridge: BridgeServer
  setPairingToken: (token: string) => void
  /** 连上去并发出 hello, 收集收到的事件与关闭码. */
  greet: (payload: Record<string, unknown>) => Promise<{ events: { event?: string, payload?: { reason?: string } }[], closeCode: number | null }>
  dispose: () => Promise<void>
}

/** 本次运行的握手令牌; 与配对令牌是两回事. */
const HANDSHAKE = 'handshake-token'

/**
 * 起一个测试用的桥.
 *
 * @param pairingToken 初始的配对令牌配置 (空串表示还没配对).
 * @returns 测试装置.
 */
async function startBridge(pairingToken: string): Promise<Harness> {
  let configured = pairingToken
  const ctx = new Context()
  const bridge = new BridgeServer(ctx, HANDSHAKE, () => configured)
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port

  return {
    port,
    bridge,
    setPairingToken: (token) => { configured = token },
    dispose: async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
    greet: async (payload) => {
      const events: { event?: string, payload?: { reason?: string } }[] = []
      let closeCode: number | null = null
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ext/bridge`, {
        headers: { 'x-dsh-bridge-token': HANDSHAKE },
      })
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => { resolve() })
        socket.on('error', reject)
      })
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8')) as { kind?: string, event?: string, payload?: { reason?: string } }
        if (frame.kind === 'event') events.push({ event: frame.event, payload: frame.payload })
      })
      const closed = new Promise<void>((resolve) => { socket.on('close', (code) => { closeCode = code; resolve() }) })
      socket.send(JSON.stringify({ kind: 'event', event: 'hello', payload }))
      // 通过的情况不会关闭连接, 所以等一小会儿再收尾.
      await Promise.race([closed, new Promise<void>((resolve) => { setTimeout(resolve, 300) })])
      if (closeCode === null) socket.close()
      return { events, closeCode }
    },
  }
}

let harness: Harness | null = null

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

beforeEach(() => { harness = null })

describe('配对令牌校验', () => {
  it('dsh 还没配置令牌时拒绝, 并告诉用户去哪里抄', async () => {
    harness = await startBridge('')
    const result = await harness.greet({ protocolVersion: 1, pairingToken: 'whatever' })

    // 关键: 拒绝原因要送到扩展, 否则用户只会看到"连不上".
    const rejection = result.events.find(event => event.event === 'pairing-rejected')
    expect(rejection, '应当把拒绝原因作为事件发回扩展').toBeDefined()
    expect(rejection?.payload?.reason).toContain('配对令牌输入框')
    // 状态里也要留下原因, 供 browser_status 与配置页显示.
    expect(harness.bridge.connectionState.pairingError).toContain('配对令牌输入框')
  })

  it('扩展没报令牌时拒绝', async () => {
    harness = await startBridge('expected-token')
    const result = await harness.greet({ protocolVersion: 1 })
    const rejection = result.events.find(event => event.event === 'pairing-rejected')
    expect(rejection?.payload?.reason).toContain('没有报上配对令牌')
  })

  it('令牌不一致时拒绝', async () => {
    harness = await startBridge('expected-token')
    const result = await harness.greet({ protocolVersion: 1, pairingToken: 'wrong-token' })
    const rejection = result.events.find(event => event.event === 'pairing-rejected')
    expect(rejection?.payload?.reason).toContain('不一致')
  })

  it('令牌一致时接受, 并清掉之前的配对错误', async () => {
    harness = await startBridge('expected-token')
    // 先用错的令牌触发一次拒绝.
    await harness.greet({ protocolVersion: 1, pairingToken: 'wrong-token' })
    expect(harness.bridge.connectionState.pairingError).not.toBeNull()

    // 用户改成对的之后应当能连上, 而且错误状态要清掉.
    const result = await harness.greet({ protocolVersion: 1, pairingToken: 'expected-token' })
    expect(result.events.some(event => event.event === 'pairing-rejected')).toBe(false)
    expect(harness.bridge.connectionState.pairingError).toBeNull()
    // 握手成功后连接保持打开 (没有被关闭).
    expect(result.closeCode).toBeNull()
  })

  it('改配置后立刻生效: 校验用的是当前值而不是构造时的值', async () => {
    harness = await startBridge('first-token')
    // 先配对的令牌能通过.
    const accepted = await harness.greet({ protocolVersion: 1, pairingToken: 'first-token' })
    expect(accepted.events.some(event => event.event === 'pairing-rejected')).toBe(false)

    // 用户在 dsh 里换成了新令牌 (volatile 字段, 不该要求重挂插件).
    harness.setPairingToken('second-token')
    // 旧令牌随即失效, 新令牌通过.
    const stale = await harness.greet({ protocolVersion: 1, pairingToken: 'first-token' })
    expect(stale.events.some(event => event.event === 'pairing-rejected')).toBe(true)
    const fresh = await harness.greet({ protocolVersion: 1, pairingToken: 'second-token' })
    expect(fresh.events.some(event => event.event === 'pairing-rejected')).toBe(false)
  })
})
