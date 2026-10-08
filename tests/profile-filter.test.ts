/**
 * 独立 profile 开着时, 桥只接受那份窗口的连接.
 *
 * 日常 Chrome 也会连上同一条 native host 通道. 若不在握手时按 user-data-dir 过滤,
 * 它会把已经握好手的独立窗口顶掉, 状态面又把日常 Chrome 当成目标浏览器.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { BridgeServer } from '../src/bridge/server.ts'

const HANDSHAKE = 'handshake-token'
const PAIRING = 'pair-token'
const PROFILE = '/tmp/dsh-browser/profile'
const DAILY = '/Users/me/Library/Application Support/Google/Chrome'

interface Connection {
  socket: WebSocket
  closed: Promise<number>
}

interface Harness {
  bridge: BridgeServer
  setExpectedDir: (dir: string | null) => void
  connect: (userDataDir: string | null) => Promise<Connection>
  dispose: () => Promise<void>
}

async function startBridge(expectedDir: string | null): Promise<Harness> {
  let expected = expectedDir
  const ctx = new Context()
  const bridge = new BridgeServer(ctx, HANDSHAKE, () => PAIRING, () => expected)
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port

  return {
    bridge,
    setExpectedDir: (dir) => { expected = dir },
    dispose: async () => {
      bridge.dispose()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
    connect: async (userDataDir) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ext/bridge`, {
        headers: { 'x-dsh-bridge-token': HANDSHAKE },
      })
      const closed = new Promise<number>((resolve) => { socket.on('close', (code) => { resolve(code) }) })
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => { resolve() })
        socket.on('error', reject)
      })
      const payload: Record<string, unknown> = {
        protocolVersion: 1,
        extensionId: 'x',
        version: '0.1.0',
        boundTabId: null,
        pairingToken: PAIRING,
      }
      if (userDataDir !== null) payload.userDataDir = userDataDir
      socket.send(JSON.stringify({ kind: 'event', event: 'hello', payload }))
      await new Promise<void>((resolve) => { setTimeout(resolve, 80) })
      return { socket, closed }
    },
  }
}

let harness: Harness | null = null

beforeEach(() => { harness = null })
afterEach(async () => {
  await harness?.dispose()
  harness = null
})

describe('独立 profile 的连接过滤', () => {
  it('没有报 user-data-dir 的连接不能成为 live', async () => {
    harness = await startBridge(PROFILE)
    const connection = await harness.connect(null)
    expect(harness.bridge.connectionState.connected).toBe(false)
    await expect(connection.closed).resolves.toBe(1008)
  })

  it('日常 Chrome 的目录不能顶掉独立 profile', async () => {
    harness = await startBridge(PROFILE)
    const standalone = await harness.connect(PROFILE)
    expect(harness.bridge.connectionState.connected).toBe(true)
    expect(harness.bridge.connectionState.peerUserDataDir).toBe(PROFILE)

    const daily = await harness.connect(DAILY)
    await expect(daily.closed).resolves.toBe(1008)
    expect(harness.bridge.connectionState.connected).toBe(true)
    expect(harness.bridge.connectionState.peerUserDataDir).toBe(PROFILE)
    expect(standalone.socket.readyState).toBe(WebSocket.OPEN)
  })

  it('开关中途打开时, 已握过手的日常连接必须立刻断开', async () => {
    harness = await startBridge(null)
    await harness.connect(DAILY)
    expect(harness.bridge.connectionState.connected).toBe(true)

    harness.setExpectedDir(PROFILE)
    harness.bridge.syncPairing()
    expect(harness.bridge.connectionState.connected).toBe(false)
    expect(harness.bridge.connectionState.peerUserDataDir).toBeNull()
  })
})
