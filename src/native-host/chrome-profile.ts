/**
 * 从拉起 native host 的 Chrome 进程上读出 `--user-data-dir`.
 *
 * 扩展自己拿不到这份路径. host 是 Chrome 用 exec 拉起的 (包装脚本 `exec` 掉自己),
 * 所以沿父进程往上走就能看到启动参数. 独立 profile 开着时, 桥靠这个判断连上来的
 * 是不是那份窗口, 而不是把日常 Chrome 的连接当成已经就绪.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 沿父进程最多走几层; Chrome 和 host 之间偶尔会隔着 helper. */
const MAX_ANCESTORS = 8

/** 读进程命令行 / 父进程的钩子, 测试里注入, 正式路径走系统. */
export interface ProcessReaders {
  /** 从哪个 pid 开始往上走; 默认是本进程. */
  startPid?: number
  /** 读这个 pid 的完整命令行. */
  readCommand?: (pid: number) => Promise<string | null>
  /** 读这个 pid 的父进程号. */
  readParent?: (pid: number) => Promise<number | null>
}

/**
 * 从命令行里抽出 `--user-data-dir` 的值.
 *
 * @param command 完整命令行.
 * @returns 目录; 没有这个参数则为 null.
 */
export function userDataDirFromCommandLine(command: string): string | null {
  const match = command.match(/--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/u)
  if (match === null) return null
  const value = match[1] ?? match[2] ?? match[3]
  if (value === undefined || value === '') return null
  return value
}

/**
 * 沿祖先进程找 Chrome 的 user-data-dir.
 *
 * 环境变量 `DSH_BROWSER_USER_DATA_DIR` 优先: 测试和排障用, 正式路径不应依赖它.
 *
 * @param hooks 可选的进程读取钩子.
 * @returns 找到的目录; 找不到为 null.
 */
export async function detectChromeUserDataDir(hooks: ProcessReaders = {}): Promise<string | null> {
  const usingHooks = hooks.startPid !== undefined || hooks.readCommand !== undefined || hooks.readParent !== undefined
  if (!usingHooks) {
    const fromEnv = process.env['DSH_BROWSER_USER_DATA_DIR']
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  }

  const readCommand = hooks.readCommand ?? defaultReadCommand
  const readParent = hooks.readParent ?? defaultReadParent
  let pid = hooks.startPid ?? process.ppid
  for (let i = 0; i < MAX_ANCESTORS; i += 1) {
    if (pid <= 1) break
    const command = await readCommand(pid)
    if (command !== null) {
      const dir = userDataDirFromCommandLine(command)
      if (dir !== null) return dir
    }
    const parent = await readParent(pid)
    if (parent === null || parent <= 1 || parent === pid) break
    pid = parent
  }
  return null
}

/**
 * 读本平台上一个进程的命令行.
 *
 * @param pid 进程号.
 * @returns 命令行; 读不到为 null.
 */
async function defaultReadCommand(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const raw = await readFile(`/proc/${String(pid)}/cmdline`)
      const text = raw.toString('utf8').replace(/\0/gu, ' ').trim()
      return text === '' ? null : text
    } catch {
      return null
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'args='], { timeout: 1_000 })
    const text = stdout.trim()
    return text === '' ? null : text
  } catch {
    return null
  }
}

/**
 * 读本平台上一个进程的父进程号.
 *
 * @param pid 进程号.
 * @returns 父进程号; 读不到为 null.
 */
async function defaultReadParent(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      const raw = await readFile(`/proc/${String(pid)}/status`, 'utf8')
      const line = raw.split('\n').find(entry => entry.startsWith('PPid:'))
      if (line === undefined) return null
      const value = Number.parseInt(line.slice(5).trim(), 10)
      return Number.isInteger(value) ? value : null
    } catch {
      return null
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'ppid='], { timeout: 1_000 })
    const value = Number.parseInt(stdout.trim(), 10)
    return Number.isInteger(value) ? value : null
  } catch {
    return null
  }
}
