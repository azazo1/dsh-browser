/**
 * 配对校验必须在**每次操作**时都成立, 而不只是握手那一次.
 *
 * 用户报的现象: 填对一次令牌之后, 在它后面随便加些后缀, 浏览器操作**仍然继续可用**.
 *
 * 原因不是比较写错了 (`timingSafeEqual` 在长度不等时返回 false, 这一条另有测试), 而是校验的
 * **时机**: 它只在收到 `hello` 时跑一次. 连接一旦建立就长期挂着, 而用户改配置不会触发新的握手
 * —— 于是"把令牌改坏"这件事在界面上看不出任何效果, 直到某次重连才突然生效. 一个改动不立即生效
 * 的鉴权开关, 等于没有开关.
 *
 * 所以这里复现完整的时序: 握手通过 -> 建立连接 -> 用户改配置加后缀 -> 在这个还开着的连接上
 * 发起操作. 最后一步必须被拒绝.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { BridgeCallError, BridgeServer } from '../src/bridge/server.ts'
import { Config } from '../src/config.ts'
import { BrowserRuntime, describeBridgeError } from '../src/runtime.ts'

/** 本次运行的握手令牌; 与配对令牌是两回事. */
const HANDSHAKE = 'handshake-token'

/** 测试装置. */
interface Harness {
  bridge: BridgeServer
  setPairingToken: (token: string) => void
  /** 连上并发出 hello, 返回这条连接以及它收到的事件. */
  connect: (payload: Record<string, unknown>) => Promise<{
    socket: WebSocket
    events: { event?: string, payload?: { reason?: string } }[]
    closed: Promise<number>
    /** 在这条连接上等一条结果帧; 超时返回 null. */
    awaitResult: (timeoutMs: number) => Promise<{ kind?: string, ok?: boolean, error?: { code?: string, message?: string } } | null>
  }>
  /** 只建立 socket, 不发 hello; 用来验证读状态不会误杀正在握手的连接. */
  connectRaw: () => Promise<{ socket: WebSocket, closed: Promise<number> }>
  dispose: () => Promise<void>
}

/**
 * 起一个测试用的桥.
 *
 * @param pairingToken 初始配对令牌.
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

  const openSocket = async (): Promise<WebSocket> => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ext/bridge`, {
      headers: { 'x-dsh-bridge-token': HANDSHAKE },
    })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => { resolve() })
      socket.on('error', reject)
    })
    return socket
  }

  return {
    bridge,
    setPairingToken: (token) => { configured = token },
    dispose: async () => {
      bridge.dispose()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
    connectRaw: async () => {
      const socket = await openSocket()
      const closed = new Promise<number>((resolve) => { socket.on('close', (code) => { resolve(code) }) })
      return { socket, closed }
    },
    connect: async (payload) => {
      const events: { event?: string, payload?: { reason?: string } }[] = []
      const results: string[] = []
      let resolveResult: (() => void) | null = null
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ext/bridge`, {
        headers: { 'x-dsh-bridge-token': HANDSHAKE },
      })
      const closed = new Promise<number>((resolve) => { socket.on('close', (code) => { resolve(code) }) })
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8')) as { kind?: string, event?: string, payload?: unknown }
        if (frame.kind === 'event') events.push({ event: frame.event, payload: frame.payload as { reason?: string } })
        if (frame.kind === 'result' || frame.kind === 'error') {
          results.push(data.toString('utf8'))
          resolveResult?.()
        }
      })
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => { resolve() })
        socket.on('error', reject)
      })
      socket.send(JSON.stringify({ kind: 'event', event: 'hello', payload }))
      // 给 handleFrame 一点时间处理 hello.
      await new Promise<void>((resolve) => { setTimeout(resolve, 80) })
      return {
        socket,
        events,
        closed,
        awaitResult: async (timeoutMs) => {
          if (results.length === 0) {
            await Promise.race([
              new Promise<void>((resolve) => { resolveResult = resolve }),
              new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs) }),
            ])
          }
          const raw = results.shift()
          return raw === undefined ? null : JSON.parse(raw) as never
        },
      }
    },
  }
}

let harness: Harness | null = null

beforeEach(() => { harness = null })
afterEach(async () => {
  await harness?.dispose()
  harness = null
})

/** 一次合法的 hello 载荷. */
const GOOD_HELLO = { protocolVersion: 1, extensionId: 'x', version: '0.1.0', boundTabId: null, pairingToken: 'correct-token' }

describe('配对令牌的校验时机', () => {
  it('令牌带后缀时, 在已建立的连接上发起的操作必须被拒绝', async () => {
    harness = await startBridge('correct-token')
    const connection = await harness.connect(GOOD_HELLO)
    // 握手通过, 连接是活的, 而且它确实能干活.
    expect(connection.events.some(event => event.event === 'pairing-rejected')).toBe(false)

    // 用户把配置改成"正确令牌 + 后缀". 这一步不触发重连, 所以考验的是**后续操作**要不要重新校验.
    harness.setPairingToken('correct-token-suffix')

    const call = harness.bridge.call('page.text', {}, new AbortController().signal)
    connection.socket.send(JSON.stringify({ kind: 'call', id: 1, method: 'page.text', args: {}, timeoutMs: 500 }))
    // 桥必须在把调用转出去之前就把它挡下.
    await expect(call).rejects.toThrow(/配对/u)
  })

  it('令牌被清空时, 在已建立的连接上发起的操作同样被拒绝', async () => {
    harness = await startBridge('correct-token')
    await harness.connect(GOOD_HELLO)
    // 清空配置等于"不再授权任何扩展", 这时旧连接不该还能用.
    harness.setPairingToken('')
    await expect(harness.bridge.call('page.text', {}, new AbortController().signal)).rejects.toThrow(/配对/u)
  })

  it('被拒的原因要原样传到用户面前, 不能被固定的"未连接"文案盖掉', async () => {
    // 这一条守的是我差点犯的错: 起初我复用了 no-binding 这个错误码, 而宿主把它映射成一段固定
    // 文案 ("扩展没有连着 dsh..."), 于是"你把令牌改错了"这个真正的原因会被整段丢掉, 用户看到
    // 的是一句与事实不符的提示.
    const message = describeBridgeError(new BridgeCallError(
      'pairing-rejected',
      '配对令牌不一致. 请打开浏览器扩展的弹出面板, 复制其中的配对令牌, 覆盖 dsh 配置里的 pairingToken.',
    ))
    expect(message).toContain('配对令牌不一致')
    expect(message).toContain('pairingToken')
    // 不能退化成那句与事实不符的通用提示.
    expect(message).not.toContain('扩展没有连着 dsh')
  })

  it('令牌没变时操作照常转发 (校验不能把正常路径也挡掉)', async () => {
    harness = await startBridge('correct-token')
    const connection = await harness.connect(GOOD_HELLO)

    const pending = harness.bridge.call('page.text', {}, new AbortController().signal)
    connection.socket.send(JSON.stringify({ kind: 'result', id: 1, ok: true, value: { url: 'u', title: 't', text: 'x', truncated: false } }))
    await expect(pending).resolves.toEqual({ url: 'u', title: 't', text: 'x', truncated: false })
  })

  it('改坏令牌后再读状态, 必须立刻报未连接, 不能等下一次页面操作', async () => {
    // 用户报的现象: 填对令牌连上之后, 把令牌改错, 点配置页的"刷新状态", 界面仍显示已连接.
    // 刷新走的是读状态, 不会发任何浏览器调用; 只在 call() 里复查等于这条路完全没守门.
    harness = await startBridge('correct-token')
    const connection = await harness.connect(GOOD_HELLO)
    expect(harness.bridge.connectionState.connected).toBe(true)
    expect(harness.bridge.connectionState.pairingError).toBeNull()

    harness.setPairingToken('correct-token-suffix')
    harness.bridge.syncPairing()

    // 同一轮读状态就必须已经是未连接: 如果要等 close 事件, 配置页这次刷新仍会显示已连接.
    const state = harness.bridge.connectionState
    expect(state.connected).toBe(false)
    expect(state.pairingError).toContain('不一致')
    await expect(connection.closed).resolves.toBe(1008)
    expect(connection.events.some(event => event.event === 'pairing-rejected')).toBe(true)
  })

  it('握手还没完成时读状态, 不能把正在连的连接掐掉', async () => {
    harness = await startBridge('correct-token')
    const raw = await harness.connectRaw()
    expect(harness.bridge.connectionState.connected).toBe(false)

    harness.bridge.syncPairing()
    expect(raw.socket.readyState).toBe(WebSocket.OPEN)

    raw.socket.send(JSON.stringify({ kind: 'event', event: 'hello', payload: GOOD_HELLO }))
    await new Promise<void>((resolve) => { setTimeout(resolve, 80) })
    expect(harness.bridge.connectionState.connected).toBe(true)
    expect(harness.bridge.connectionState.pairingError).toBeNull()
  })

  it('runtime.status 必须触发配对复查, 否则配置页刷新看不到改令牌', async () => {
    // 配置页的"刷新状态"走 GET /status -> runtime.status(). 桥上有复查方法还不够,
    // 读状态这条路必须真的去调它.
    let synced = 0
    const ctx = new Context()
    const config = Config({})
    const bridge = {
      token: 'tok',
      connectionState: {
        connected: true,
        extensionVersion: '0.1.0',
        boundTabId: null,
        lastError: null,
        pairingError: null,
        userScriptsAvailable: true,
      },
      call: async () => undefined,
      syncPairing: () => { synced += 1 },
    }
    const runtime = new BrowserRuntime(ctx, config, bridge as never)
    await runtime.status()
    expect(synced).toBe(1)
  })
})
