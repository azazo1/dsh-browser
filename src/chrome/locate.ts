/**
 * 定位 Google Chrome 可执行文件.
 *
 * 只支持 Google Chrome (用户的明确选择), 因此每个平台只有一组候选路径, 不需要
 * 扫描 Chromium / Edge / Brave 各自的安装位置.
 *
 * 探测顺序: 配置里显式给的路径优先, 其次按平台的标准安装位置, 最后尝试 PATH.
 * 显式路径存在但不可执行时不静默回退, 而是直接报错: 用户明明指定了一个路径, 却
 * 悄悄用了另一个, 这种"帮你猜"的行为比报错更难排查.
 */

import { access, constants } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 探测失败时抛出的错误. */
export class ChromeNotFoundError extends Error {
  /**
   * @param tried 已经尝试过的全部路径.
   */
  constructor(readonly tried: readonly string[]) {
    super(
      '找不到 Google Chrome 可执行文件. 已尝试: '
      + (tried.length === 0 ? '(没有候选路径)' : tried.join(', '))
      + '. 请在插件配置里填写 chromePath, 例如 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome.',
    )
    this.name = 'ChromeNotFoundError'
  }
}

/** 判断路径是否存在且可执行. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 按平台列出候选路径. */
function candidatePaths(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ]
  }
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    return [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
  }
  return [
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]
}

/**
 * 在 PATH 里找 Chrome 的命令名.
 *
 * @returns 找到的绝对路径; PATH 里没有时返回 null.
 */
async function fromPath(): Promise<string | null> {
  const names = process.platform === 'win32' ? ['chrome.exe'] : ['google-chrome', 'google-chrome-stable', 'chrome']
  const which = process.platform === 'win32' ? 'where' : 'which'
  for (const name of names) {
    const found = await new Promise<string | null>((resolve) => {
      execFile(which, [name], (error, stdout) => {
        if (error !== null && error !== undefined) {
          resolve(null)
          return
        }
        const first = stdout.split(/\r?\n/u).map(line => line.trim()).find(line => line !== '')
        resolve(first ?? null)
      })
    })
    if (found !== null && await isExecutable(found)) return found
  }
  return null
}

/** 一次探测的结果. */
export interface ChromeLocation {
  /** 可执行文件绝对路径. */
  path: string
  /** 该路径是怎么来的, 用于在状态里说明. */
  source: 'configured' | 'standard-path' | 'PATH'
}

/**
 * 定位 Chrome.
 *
 * @param configured 配置里显式给出的路径.
 * @returns 定位结果.
 * @throws ChromeNotFoundError 全部候选都不可用时抛出.
 */
export async function locateChrome(configured: string | undefined): Promise<ChromeLocation> {
  const tried: string[] = []
  if (configured !== undefined && configured.trim() !== '') {
    tried.push(configured)
    if (await isExecutable(configured)) return { path: configured, source: 'configured' }
    throw new ChromeNotFoundError(tried)
  }

  const candidates = candidatePaths()
  tried.push(...candidates)
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return { path: candidate, source: 'standard-path' }
  }

  const fromPathResult = await fromPath()
  if (fromPathResult !== null) return { path: fromPathResult, source: 'PATH' }
  tried.push('PATH 中的 google-chrome / google-chrome-stable / chrome')

  throw new ChromeNotFoundError(tried)
}
