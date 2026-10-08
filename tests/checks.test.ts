/**
 * 配置页检查清单的状态.
 *
 * 这组测试存在的原因很具体: 浏览器求值那一行曾经在"状态未知"时显示**绿色**, 因为映射只有
 * "过/不过"两态, 而判断写成了 `!== false` —— `null` 于是落进了"过". 绿色意味着"已确认可用",
 * 旁边却写着"状态未知", 是最容易让人误信的那种错.
 *
 * 而它能溜过去, 是因为那段映射当时内联在 `.tsx` 组件里, 没有任何测试覆盖. 所以这里把每行的
 * 状态逐条钉住, 并专门断言"未知不等于正常"。
 */

import { describe, expect, it } from 'vitest'
import { checks } from '../src/client/checks.ts'
import type { CheckState } from '../src/client/checks.ts'
import { extensionLinkCounts, type StatusPayload } from '../shared/status.ts'

/**
 * 一份"全部正常"的状态.
 *
 * 各用例只改自己关心的字段, 于是断言里出现的差异一定来自那个字段.
 */
const OK_STATUS: StatusPayload = {
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromeSource: 'standard-path',
  chromeError: null,
  profileDir: '/data/dsh-browser/profile',
  dataDir: '/data/dsh-browser',
  extensionId: 'hfbmjjcgbobkpmmkhfjgebcojhjpdokd',
  extensionDir: '/data/dsh-browser/extension',
  manifestPath: '/Users/me/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.azazo1.dsh_browser.json',
  manifestReady: true,
  manifestStale: false,
  interpreter: '/usr/local/bin/node',
  bridgeConnected: true,
  extensionVersion: '0.1.0',
  boundTabId: 1391393307,
  bridgeError: null,
  launchStandaloneChromeProfile: false,
  holderId: null,
  pairingConfigured: true,
  pairingError: null,
  userScriptsAvailable: true,
  launchArgs: null,
  peerUserDataDir: null,
  manualSteps: [],
  ready: true,
}

/**
 * 在基准之上改几个字段.
 *
 * @param patch 要覆盖的字段.
 * @returns 新的状态.
 */
function withPatch(patch: Partial<StatusPayload>): StatusPayload {
  return { ...OK_STATUS, ...patch }
}

/**
 * 取某一行的状态.
 *
 * @param status 状态.
 * @param key 行的键.
 * @returns 该行的状态.
 */
function stateOf(status: StatusPayload, key: string): CheckState {
  const row = checks(status).find(candidate => candidate.key === key)
  expect(row, `找不到 ${key} 这一行`).toBeDefined()
  return row!.state
}

describe('配置页检查清单', () => {
  it('全部正常时每一行都是 done', () => {
    for (const row of checks(OK_STATUS)) {
      expect(row.state, `${row.key} 在正常状态下不是 done`).toBe('done')
    }
  })

  it('浏览器求值状态未知时既不是 done 也不是 warning', () => {
    // 这就是那个 bug: 扩展未连上时无从判断开关开没开.
    const status = withPatch({ userScriptsAvailable: null, bridgeConnected: false })
    const state = stateOf(status, 'checkEvaluate')
    // 未知不能用 done 表示: 绿色意味着"已确认可用", 而实际上什么都没确认.
    expect(state).not.toBe('done')
    // 也不该是 warning: 还没有需要用户处理的东西.
    expect(state).not.toBe('warning')
    expect(state).toBe('idle')
  })

  it('浏览器求值确认可用时才是 done', () => {
    expect(stateOf(withPatch({ userScriptsAvailable: true }), 'checkEvaluate')).toBe('done')
  })

  it('浏览器求值确实关着时是 warning 而不是 error', () => {
    // 它只是少一个工具, 其余照常可用, 所以不该报成配置错误.
    expect(stateOf(withPatch({ userScriptsAvailable: false }), 'checkEvaluate')).toBe('warning')
  })

  it('尚未绑定标签页是 idle: 打开页面之前本来就没有绑定', () => {
    // 这不是问题, 所以既不该是 warning (让人以为哪里错了) 也不该是 done.
    expect(stateOf(withPatch({ boundTabId: null }), 'checkBinding')).toBe('idle')
    expect(stateOf(withPatch({ boundTabId: 42 }), 'checkBinding')).toBe('done')
  })

  it('挡住整条链路的缺失是 error', () => {
    // 找不到 Chrome 就什么都做不了.
    expect(stateOf(withPatch({ chromePath: null, chromeError: '未找到' }), 'checkChrome')).toBe('error')
    // 没装连接组件同理.
    expect(stateOf(withPatch({ manifestReady: false }), 'checkHost')).toBe('error')
    // 没配对令牌会让所有浏览器操作被拒.
    expect(stateOf(withPatch({ pairingConfigured: false }), 'checkPairing')).toBe('error')
    expect(stateOf(withPatch({ pairingConfigured: true, pairingError: '不一致' }), 'checkPairing')).toBe('error')
  })

  it('可以就地修好的问题, 以及需要用户动手的, 是 warning 而不是 error', () => {
    // 清单装过但和当前配置不符: 旁边的安装按钮就能修.
    expect(stateOf(withPatch({ manifestStale: true, manifestReady: true }), 'checkHost')).toBe('warning')
    // 扩展没连上通常是浏览器没开, 配置本身没错.
    expect(stateOf(withPatch({ bridgeConnected: false }), 'checkExtension')).toBe('warning')
  })

  it('允许 dsh 自行启动时, 还没连上不算问题', () => {
    // 这条路本来就是"先启动再连接", 若算问题会让它看起来永远没就绪.
    const status = withPatch({ bridgeConnected: false, launchStandaloneChromeProfile: true })
    expect(stateOf(status, 'checkLaunch')).toBe('done')
    expect(stateOf(withPatch({ bridgeConnected: false, launchStandaloneChromeProfile: false }), 'checkLaunch')).toBe('warning')
  })

  it('独立 profile 尚未启动时, 日常 Chrome 的连接不算就绪', () => {
    expect(extensionLinkCounts({
      launchStandaloneChromeProfile: true,
      bridgeConnected: true,
      launchArgs: null,
      profileDir: '/data/dsh-browser/profile',
      peerUserDataDir: '/Users/me/Library/Application Support/Google/Chrome',
    })).toBe(false)
    expect(extensionLinkCounts({
      launchStandaloneChromeProfile: false,
      bridgeConnected: true,
      launchArgs: null,
      profileDir: '/data/dsh-browser/profile',
    })).toBe(true)
    expect(extensionLinkCounts({
      launchStandaloneChromeProfile: true,
      bridgeConnected: true,
      launchArgs: null,
      profileDir: '/data/dsh-browser/profile',
      peerUserDataDir: '/data/dsh-browser/profile',
    })).toBe(true)
    // 打开这个开关就是选择另一份环境; 桥上那条连接属于日常窗口, 拿它报绿灯会让人以为已经在用独立 profile.
    const pending = withPatch({
      launchStandaloneChromeProfile: true,
      launchArgs: null,
      bridgeConnected: true,
      peerUserDataDir: '/Users/me/Library/Application Support/Google/Chrome',
      userScriptsAvailable: true,
      boundTabId: 42,
    })
    expect(stateOf(pending, 'checkExtension')).toBe('idle')
    expect(stateOf(pending, 'checkEvaluate')).toBe('idle')
    expect(stateOf(pending, 'checkBinding')).toBe('idle')

    const disconnected = withPatch({
      launchStandaloneChromeProfile: true,
      launchArgs: null,
      bridgeConnected: false,
      extensionVersion: null,
      userScriptsAvailable: null,
      boundTabId: null,
    })
    expect(stateOf(disconnected, 'checkExtension')).toBe('idle')
  })

  it('独立 profile 启动后, 才用那条连接判定扩展是否就绪', () => {
    const launched = withPatch({
      launchStandaloneChromeProfile: true,
      launchArgs: ['--user-data-dir=/data/dsh-browser/profile'],
      bridgeConnected: true,
      peerUserDataDir: '/data/dsh-browser/profile',
    })
    expect(stateOf(launched, 'checkExtension')).toBe('done')
    expect(stateOf(launched, 'checkEvaluate')).toBe('done')

    // dsh 重启后 launchArgs 没了, 但独立窗口还开着, 对端报上同一份目录就算连上.
    const afterRestart = withPatch({
      launchStandaloneChromeProfile: true,
      launchArgs: null,
      bridgeConnected: true,
      peerUserDataDir: '/data/dsh-browser/profile',
    })
    expect(stateOf(afterRestart, 'checkExtension')).toBe('done')

    const waiting = withPatch({
      launchStandaloneChromeProfile: true,
      launchArgs: ['--user-data-dir=/data/dsh-browser/profile'],
      bridgeConnected: false,
      extensionVersion: null,
      userScriptsAvailable: null,
    })
    expect(stateOf(waiting, 'checkExtension')).toBe('warning')
  })

  it('未连上桥时, 依赖握手结果的那一行必须给未知而不是绿色', () => {
    // 这条是那个 bug 的一般化: 只要桥没连上, 握手才知道的字段就一律不可信.
    const status = withPatch({ bridgeConnected: false, extensionVersion: null, userScriptsAvailable: null })
    for (const row of checks(status)) {
      // 依赖握手状态的只有求值这一行; 其余行有各自独立的判据.
      if (row.key !== 'checkEvaluate') continue
      expect(row.state, '握手还没发生, 不该给一个确定的状态').toBe('idle')
    }
  })

  it('每一行都有说明文本或明确的空值来源, 且键不重复', () => {
    const rows = checks(OK_STATUS)
    // 键重复会让 React 列表渲染出错, 也会让状态映射互相覆盖.
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
    // 每一行都要有非空的说明: 只说"没通过"等于让用户自己猜.
    for (const row of rows) {
      expect(row.detail.trim(), `${row.key} 没有说明文本`).not.toBe('')
    }
  })
})
