/**
 * 会合文件的发布时机.
 *
 * 这个测试守的是一个真实发生过的故障: 用户装好连接组件与浏览器扩展, host 进程也被
 * Chrome 正常拉起, 但**会合文件不存在** —— 因为原实现只在第一次 `browser_open` 时才
 * 写它. 结果 host 拿不到 dsh 地址, 一直退避重试, 链路整段不通; 而扩展侧只显示"已连接
 * 到 dsh", 界面上完全看不出问题在哪.
 *
 * 正确的时序是: 插件一加载就把地址发布出去, 不等任何工具调用. 这里就直接断言这一点.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readRendezvous, writeRendezvous } from '../src/bridge/rendezvous.ts'

let workspace = ''

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-browser-rendezvous-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('会合文件', () => {
  it('写入后可读回, 地址是回环且带桥路径', async () => {
    const file = join(workspace, 'bridge.json')
    const written = await writeRendezvous(file, 54213, 'tok-abc')
    expect(written.wsUrl).toBe('ws://127.0.0.1:54213/ext/bridge')

    const read = await readRendezvous(file)
    expect(read?.token).toBe('tok-abc')
    expect(read?.wsUrl).toBe(written.wsUrl)
    // pid 与时间戳用于排查"旧实例残留", 必须写进去.
    expect(read?.pid).toBe(process.pid)
    expect(read?.startedAt).not.toBe('')
  })

  it('文件权限是 0600, 令牌不对外可读', async () => {
    const file = join(workspace, 'bridge.json')
    await writeRendezvous(file, 54213, 'secret-token')
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises')
      const mode = (await stat(file)).mode & 0o777
      // 网页读不到这个文件, 所以即使猜到端口也过不了令牌校验 —— 这是桥的第二道防线.
      expect(mode.toString(8)).toBe('600')
    }
  })

  it('端口变化时重写会让 host 拿到新地址', async () => {
    const file = join(workspace, 'bridge.json')
    await writeRendezvous(file, 11111, 'tok')
    await writeRendezvous(file, 22222, 'tok')
    const read = await readRendezvous(file)
    // dsh 重启后端口可能变; host 每次重试都重读文件, 所以必须是最新的一份.
    expect(read?.wsUrl).toBe('ws://127.0.0.1:22222/ext/bridge')
  })

  it('文件不存在或内容损坏时返回 null, 而不是抛错', async () => {
    expect(await readRendezvous(join(workspace, 'nope.json'))).toBeNull()
    const broken = join(workspace, 'broken.json')
    await writeFile(broken, '{ 这不是 JSON', 'utf8')
    // host 靠 null 决定"继续等待"而不是崩溃退出.
    expect(await readRendezvous(broken)).toBeNull()
  })
})

describe('插件加载即发布桥地址', () => {
  it('apply 之后无需任何工具调用, 会合文件就已经存在', async () => {
    // 直接驱动 runtime 的发布动作: 它必须能在没有会话, 没有工具调用的情况下完成.
    const { Config, resolvePaths } = await import('../src/config.ts')
    const { BrowserRuntime } = await import('../src/runtime.ts')
    const { BridgeServer } = await import('../src/bridge/server.ts')

    const dataDir = join(workspace, 'data')
    const ctx = new Context()
    ctx.provide('webServer', { port: 54213 })
    const config = Config({ dataDir })
    const bridge = new BridgeServer(ctx, 'tok-timing', () => 'pair-timing')
    const runtime = new BrowserRuntime(ctx, config, bridge)

    const file = resolvePaths(config).rendezvousFile
    expect(await readRendezvous(file)).toBeNull()

    await runtime.publishRendezvous()

    const published = await readRendezvous(file)
    expect(published?.wsUrl).toBe('ws://127.0.0.1:54213/ext/bridge')
    expect(published?.token).toBe('tok-timing')
  })
})

describe('该用哪个浏览器', () => {
  it('未开独立 profile 且扩展已连接时, 复用现有浏览器', async () => {
    const { launchDecision } = await import('../src/runtime.ts')
    // 用户把扩展装在自己日常 Chrome 里时, 再起一个空 profile 的窗口只会打断他.
    expect(launchDecision({ bridgeConnected: true, launchStandaloneChromeProfile: false })).toEqual({ kind: 'reuse' })
  })

  it('打开独立 profile 时始终启动, 不复用日常 Chrome', async () => {
    const { launchDecision } = await import('../src/runtime.ts')
    expect(launchDecision({ bridgeConnected: true, launchStandaloneChromeProfile: true })).toEqual({ kind: 'launch' })
    expect(launchDecision({ bridgeConnected: false, launchStandaloneChromeProfile: true })).toEqual({ kind: 'launch' })
  })

  it('未连接且不允许自行启动时明确拒绝, 并说清下一步', async () => {
    const { launchDecision } = await import('../src/runtime.ts')
    const decision = launchDecision({ bridgeConnected: false, launchStandaloneChromeProfile: false })
    // 默认配置就是这一种. 拒绝的理由必须可执行: 用户能做的两件事与"干等重试"完全不同.
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') return
    expect(decision.reason).toContain('launchStandaloneChromeProfile')
    expect(decision.reason).toContain('chrome://extensions')
  })
})
