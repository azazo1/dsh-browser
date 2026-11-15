/**
 * 待办文案: "扩展没连上"到底该让模型做什么.
 *
 * 这段文案最容易出的一类错: 浏览器只是没启动, 待办却写着"去 chrome://extensions 加载扩展",
 * 于是模型让用户白折腾一遍. 反过来, 真的缺组件时又不能让模型去"再调用一次".
 * 所以这里把几条分支分别钉住.
 */

import { describe, expect, it } from 'vitest'
import { browserNextSteps } from '../src/hints.ts'
import type { NextStepsInput } from '../src/hints.ts'

/** 组件齐全的平台状态. */
const READY_HOST = {
  manifestReady: true,
  extensionReady: true,
  manualSteps: [
    `在 chrome://extensions 打开开发者模式, 点"加载已解压的扩展程序", 选中 /data/dsh-browser/extension.`,
  ],
}

/** 一份"组件齐, Chrome 在, 扩展没连上, 没有任何启动开关"的基准. */
const BASE: NextStepsInput = {
  chromeFound: true,
  hostError: null,
  host: READY_HOST,
  linked: false,
  launchStandaloneChromeProfile: false,
  autoLaunchChrome: false,
  launched: false,
  lastLaunchError: null,
  pairingError: null,
}

describe('待办文案', () => {
  it('已连上就没有待办', () => {
    expect(browserNextSteps({ ...BASE, linked: true })).toEqual([])
  })

  it('允许自动启动时, 指向 browser_open, 而不是去加载扩展', () => {
    const steps = browserNextSteps({ ...BASE, autoLaunchChrome: true })
    const text = steps.join(' ')
    // 这条是本次修复的核心: 浏览器可能只是没启动, 让用户去改配置是白折腾.
    expect(text).toContain('调用 browser_open')
    expect(text).toContain('不代表需要改配置')
    expect(text).not.toContain('加载已解压的扩展程序')
    // 必须点名 browser_open: browser_status 只读, 再查不会启动浏览器, 容易原地打转.
    expect(text).toContain('browser_status 只读')
  })

  it('不允许自动启动时才让用户打开自己的浏览器', () => {
    const text = browserNextSteps(BASE).join(' ')
    expect(text).toContain('打开装了该扩展的那个 Chrome')
    expect(text).not.toContain('再调用一次')
  })

  it('独立 profile 未启动时说明会另开窗口', () => {
    const text = browserNextSteps({ ...BASE, launchStandaloneChromeProfile: true }).join(' ')
    expect(text).toContain('另开一个窗口')
  })

  it('独立 profile 已启动但仍未连上时, 才让用户去加载扩展', () => {
    const text = browserNextSteps({
      ...BASE,
      launchStandaloneChromeProfile: true,
      launched: true,
    }).join(' ')
    expect(text).toContain('chrome://extensions')
  })

  it('找不到 Chrome 时只讲 chromePath, 不混进启动相关的话', () => {
    const steps = browserNextSteps({ ...BASE, chromeFound: false, autoLaunchChrome: true })
    expect(steps.join(' ')).toContain('chromePath')
    // Chrome 都没有, "再调用一次会自动启动"是无从兑现的承诺.
    expect(steps.join(' ')).not.toContain('再调用一次')
  })

  it('组件缺失时给出安装步骤, 不要求用户去启动浏览器', () => {
    const steps = browserNextSteps({
      ...BASE,
      host: { ...READY_HOST, extensionReady: false },
    })
    expect(steps.join(' ')).toContain('加载已解压的扩展程序')
    expect(steps.join(' ')).not.toContain('打开装了该扩展的那个 Chrome')
  })

  it('配对失败挡住一切, 不再提别的', () => {
    const steps = browserNextSteps({ ...BASE, pairingError: '配对令牌不一致', autoLaunchChrome: true })
    expect(steps).toHaveLength(1)
    expect(steps[0]).toContain('配对没通过')
  })

  it('上次启动失败会附在待办最后', () => {
    const steps = browserNextSteps({
      ...BASE,
      autoLaunchChrome: true,
      lastLaunchError: 'profile 目录被占用',
    })
    expect(steps.at(-1)).toContain('上次启动 Chrome 失败')
    expect(steps.at(-1)).toContain('profile 目录被占用')
  })
})
