/**
 * 从 Chrome 命令行抽出 user-data-dir, 以及沿父进程往上找.
 *
 * 独立 profile 能不能和日常 Chrome 分开, 取决于这段探测准不准. 命令行形态有
 * `--user-data-dir=路径` 和 `--user-data-dir 路径` 两种, 漏一种就会把独立窗口
 * 当成探测失败.
 */

import { describe, expect, it } from 'vitest'
import { detectChromeUserDataDir, userDataDirFromCommandLine } from '../src/native-host/chrome-profile.ts'

describe('Chrome user-data-dir 探测', () => {
  it('抽出 --user-data-dir= 和空格分隔两种写法', () => {
    expect(userDataDirFromCommandLine(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/dsh-browser/profile --no-first-run',
    )).toBe('/tmp/dsh-browser/profile')
    expect(userDataDirFromCommandLine(
      'chrome --user-data-dir /tmp/dsh-browser/profile --no-first-run',
    )).toBe('/tmp/dsh-browser/profile')
    expect(userDataDirFromCommandLine(
      'chrome --user-data-dir="/tmp/dir with space/profile"',
    )).toBe('/tmp/dir with space/profile')
    expect(userDataDirFromCommandLine(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    )).toBeNull()
  })

  it('沿祖先进程找到带 --user-data-dir 的那一层', async () => {
    const commands = new Map<number, string>([
      [10, '/usr/bin/node /data/nm-host.cjs /tmp/bridge.json'],
      [9, '/bin/sh /data/nm-host.sh'],
      [8, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/dsh-browser/profile'],
    ])
    const parents = new Map<number, number>([[10, 9], [9, 8], [8, 1]])
    const dir = await detectChromeUserDataDir({
      startPid: 10,
      readCommand: async (pid) => commands.get(pid) ?? null,
      readParent: async (pid) => parents.get(pid) ?? null,
    })
    expect(dir).toBe('/tmp/dsh-browser/profile')
  })

  it('整条祖先链都没有这个参数时返回 null', async () => {
    const dir = await detectChromeUserDataDir({
      startPid: 2,
      readCommand: async () => '/usr/bin/node lib/nm-host.cjs',
      readParent: async (pid) => (pid === 2 ? 1 : null),
    })
    expect(dir).toBeNull()
  })
})
