/**
 * native messaging host 的双向转发测试.
 *
 * 这是唯一能证明"整条通道真的通"的测试: 它把**构建产物** `lib/nm-host.cjs` 当子进程
 * 跑起来, 用一份真的 WebSocket 服务扮演 dsh 侧, 然后:
 *
 *   1. 检查它按会合文件里的地址连上来, 并带上令牌头;
 *   2. 从它的 stdout 读出 native messaging 帧, 检查长度前缀与 JSON 内容;
 *   3. 往它的 stdin 写一个 native messaging 帧, 检查 dsh 侧收到对应的 JSON.
 *
 * 换句话说, 扩展与 dsh 之间那两段管道 (stdio 与 WebSocket) 都在这里被真实地走过
 * 一遍, 唯一没参与的是 Chrome 自己. 这样"端口/令牌/分帧/重连"这些最容易出错的
 * 部分就不必等到用户装上扩展才发现问题.
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

const HOST_SCRIPT = join(import.meta.dirname, '..', 'lib', 'nm-host.cjs')

/** 一个被拉起的 host 子进程与它周边的临时资源. */
interface Harness {
  child: ChildProcessWithoutNullStreams
  socket: WebSocket
  tokenHeader: string | undefined
  stdoutFrames: unknown[]
  received: string[]
  dispose: () => Promise<void>
}

/**
 * 起一个假的 dsh 侧 WebSocket 服务, 拉起 host 子进程, 等两边握手完成.
 *
 * @returns 测试夹具.
 */
async function startHarness(): Promise<Harness> {
  const token = 'test-token-abc123'
  const directory = await mkdtemp(join(tmpdir(), 'dsh-browser-nm-'))
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => { server.once('listening', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务没有拿到端口')

  let tokenHeader: string | undefined
  const received: string[] = []
  let resolveSocket: (socket: WebSocket) => void = () => {}
  const socketReady = new Promise<WebSocket>((resolve) => { resolveSocket = resolve })
  server.on('connection', (socket, request) => {
    tokenHeader = request.headers['x-dsh-bridge-token'] as string | undefined
    socket.on('message', (data) => { received.push(data.toString('utf8')) })
    resolveSocket(socket)
  })

  const rendezvous = join(directory, 'bridge.json')
  await writeFile(rendezvous, JSON.stringify({
    wsUrl: `ws://127.0.0.1:${String(address.port)}/ext/bridge`,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }), 'utf8')

  const child = spawn(process.execPath, [HOST_SCRIPT, rendezvous], { stdio: 'pipe' })
  const stdoutFrames: unknown[] = []
  let buffer = Buffer.alloc(0)
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 4) return
      const length = buffer.readUInt32LE(0)
      if (buffer.length < 4 + length) return
      const payload = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      stdoutFrames.push(JSON.parse(payload.toString('utf8')))
    }
  })

  const socket = await socketReady
  return {
    child,
    socket,
    get tokenHeader() { return tokenHeader },
    stdoutFrames,
    received,
    dispose: async () => {
      child.kill('SIGKILL')
      socket.close()
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
      await rm(directory, { recursive: true, force: true })
    },
  } as Harness
}

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** 把一帧按 native messaging 的格式写到 host 的 stdin. */
function writeFrame(child: ChildProcessWithoutNullStreams, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  child.stdin.write(header)
  child.stdin.write(payload)
}

/** 轮询等待条件成立, 避免依赖固定 sleep. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('等待条件超时')
}

describe('native messaging host 的双向转发', () => {
  it('按会合文件连上 dsh 并带上令牌', async () => {
    harness = await startHarness()
    await waitFor(() => harness?.tokenHeader !== undefined)
    expect(harness.tokenHeader).toBe('test-token-abc123')
  })

  it('dsh -> host -> stdout: 帧被转成带长度前缀的 native messaging 帧', async () => {
    harness = await startHarness()
    harness.socket.send(JSON.stringify({ kind: 'call', id: 7, method: 'tabs.list', args: {}, timeoutMs: 1_000 }))
    // host 会在连通时先发一条 link-ready 事件, 所以找 call 帧而不是假定它在第一位.
    await waitFor(() => harness!.stdoutFrames.some(
      frame => (frame as { kind?: string }).kind === 'call',
    ))
    const call = harness.stdoutFrames.find(frame => (frame as { kind?: string }).kind === 'call')
    expect(call).toEqual({ kind: 'call', id: 7, method: 'tabs.list', args: {}, timeoutMs: 1_000 })
  })

  it('stdin -> host -> dsh: 扩展的帧原样到达 dsh', async () => {
    harness = await startHarness()
    writeFrame(harness.child, { kind: 'result', id: 7, ok: true, value: [{ id: 3, url: 'https://example.com' }] })
    await waitFor(() => harness!.received.length > 0)
    expect(JSON.parse(harness.received[0] ?? '{}')).toEqual({
      kind: 'result',
      id: 7,
      ok: true,
      value: [{ id: 3, url: 'https://example.com' }],
    })
  })

  it('会合文件缺失时不自暴自弃: 进程留在原地等 dsh 就绪', async () => {
    // 指向一个不存在的会合文件; host 应当保持运行并退避重试, 而不是退出.
    const missing = join(tmpdir(), `dsh-browser-missing-${String(Date.now())}.json`)
    const child = spawn(process.execPath, [HOST_SCRIPT, missing], { stdio: 'pipe' })
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(child.exitCode, 'host 不应因为读不到会合文件就退出').toBeNull()
    child.kill('SIGKILL')
  })

  it('连上 dsh 后主动告诉扩展链路已通', async () => {
    harness = await startHarness()
    // host 的 connectNative 成功只证明它自己起来了; 扩展需要这个事件才知道
    // "host 真的连上 dsh 了". 少了它, 界面只能报"已连接", 而实际链路可能是断的.
    await waitFor(() => harness!.stdoutFrames.some(
      frame => (frame as { event?: string }).event === 'link-ready',
    ))
    const ready = harness.stdoutFrames.find(frame => (frame as { event?: string }).event === 'link-ready')
    expect(ready).toBeDefined()
    expect((ready as { kind?: string }).kind).toBe('event')
  })

  it('日志只走 stderr, stdout 留给协议', async () => {
    harness = await startHarness()
    // 等它真的开始收帧, 确保已经过了启动阶段.
    harness.socket.send(JSON.stringify({ kind: 'call', id: 1, method: 'tabs.list', args: {}, timeoutMs: 1_000 }))
    await waitFor(() => harness!.stdoutFrames.length > 0)
    // stdout 上出现的每一帧都必须是 native messaging 帧; 任何一行裸日志都会让 Chrome
    // 把协议读坏, 所以这里逐帧确认结构.
    for (const frame of harness.stdoutFrames) {
      expect(typeof frame).toBe('object')
      expect(frame).not.toBeNull()
    }
  })
})
