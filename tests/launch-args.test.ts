/**
 * Chrome 启动参数与启动方式: 独立 profile 与用户日常 Chrome 的区别.
 *
 * 这一条守的是"自动启动浏览器能不能真的连上": 启动用户日常 Chrome 时若带上 --user-data-dir,
 * 起来的就是一份空白环境, 扩展与登录态都不在, 扩展永远不会连上来 —— 而那正是这条路唯一的用处.
 */

import { describe, expect, it } from 'vitest'
import { appBundleOf, buildLaunchArgs, launchTarget } from '../src/chrome/launcher.ts'

describe('Chrome 启动参数', () => {
  it('独立 profile 带上 --user-data-dir 与首次运行相关的开关', () => {
    expect(buildLaunchArgs('/data/dsh-browser/profile', ['--lang=zh-CN'])).toEqual([
      '--user-data-dir=/data/dsh-browser/profile',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=zh-CN',
    ])
  })

  it('启动用户日常 Chrome 时不带任何 profile 参数', () => {
    // 带上 --user-data-dir 就等于另起一份环境, 扩展不会跟过来.
    expect(buildLaunchArgs(null, [])).toEqual([])
    expect(buildLaunchArgs(null, ['--lang=zh-CN'])).toEqual(['--lang=zh-CN'])
  })
})

describe('Chrome 启动方式', () => {
  it('从可执行文件推出 macOS 的 .app 路径, 推不出时为 null', () => {
    expect(appBundleOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
      .toBe('/Applications/Google Chrome.app')
    // PATH 里那种裸可执行文件没有 app 包, 调用方会退回直接 spawn.
    expect(appBundleOf('/opt/google/chrome/chrome')).toBeNull()
    // Windows 与 Linux 同样没有 app 包.
    expect(appBundleOf('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBeNull()
  })

  it('独立 profile 始终直接执行 Chrome 可执行文件', () => {
    // 这条不能走 open -a: 必须由本进程传入 --user-data-dir, 否则起的不是 dsh 那份 profile.
    const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(launchTarget(executable, '/data/dsh-browser/profile', ['--user-data-dir=/data/dsh-browser/profile']))
      .toEqual({ file: executable, args: ['--user-data-dir=/data/dsh-browser/profile'] })
  })
})
