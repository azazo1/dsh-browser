/**
 * 启动 Chrome.
 *
 * 这里刻意用 `child_process.spawn` 直接拉起 Chrome, 而不是走 puppeteer / playwright.
 * 原因是那个默认行为: puppeteer 的启动器会给 Chrome 加 `--disable-extensions`
 * (puppeteer-core 的 ChromeLauncher 里那行), 而本插件的控制通道**就是扩展**.
 * 扩展被禁用的窗口里, chrome://extensions 永远是空列表, 点"加载已解压的扩展程序"
 * 没有任何反应也不报错 —— 这正是之前那次排查的经历.
 *
 * 现在用的参数只有三条, 全都不影响页面看到的自动化特征:
 *   --user-data-dir        指向 dsh 自己的持久 profile
 *   --no-first-run         跳过首次运行引导
 *   --no-default-browser-check  跳过"设为默认浏览器"提示
 *
 * 特别地, 这里**不会**出现 --remote-debugging-port / --headless /
 * --disable-extensions, 出现任何一个都意味着插件的设计前提被破坏.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

/** 启动结果. */
export interface LaunchResult {
  /** 可执行文件路径. */
  executable: string
  /** profile 目录. */
  profileDir: string
  /** 实际使用的参数. */
  args: string[]
  /** 本次 spawn 出来的进程 id; 交给已有实例时为 null. */
  pid: number | null
  /** 是不是"已有实例在跑, 本次只是把窗口带到前台". */
  handedOff: boolean
}

/** 当前被本插件拉起的 Chrome 进程; 交给已有实例时为 null. */
let current: ChildProcess | null = null

/** 组装启动参数. */
export function buildLaunchArgs(profileDir: string, extraArgs: readonly string[]): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...extraArgs,
  ]
}

/**
 * 启动 Chrome 并等到能判断"是新建实例还是交给了已有实例".
 *
 * Chrome 对同一个 user-data-dir 有进程单例: 已有实例在跑时, 新进程会把请求转交
 * 过去然后立刻以 0 退出. 因此 spawn 之后短暂观察一下退出情况, 就能区分这两种情形,
 * 而不是让调用方以为"明明起了却拿不到窗口".
 *
 * @param options 启动参数.
 * @returns 启动结果.
 */
export async function launchChrome(options: {
  executable: string
  profileDir: string
  extraArgs: readonly string[]
}): Promise<LaunchResult> {
  const { executable, profileDir, extraArgs } = options
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  const args = buildLaunchArgs(profileDir, extraArgs)

  const child = spawn(executable, args, {
    // 与 dsh 的生命周期解耦: Chrome 是用户的浏览器, dsh 退出后它应当继续开着.
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })

  const result = await new Promise<{ handedOff: boolean, pid: number | null }>((resolve, reject) => {
    let settled = false
    // 已有实例时, 转交进程一般在一秒内以 0 退出; 给足余量再判定.
    const handoffTimer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ handedOff: false, pid: child.pid ?? null })
    }, 1_500)

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(handoffTimer)
      reject(new Error(`启动 Chrome 失败: ${error.message}`, { cause: error }))
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(handoffTimer)
      // 立刻以 0 退出 = 把请求交给了已有实例.
      if (code === 0) resolve({ handedOff: true, pid: null })
      else reject(new Error(`Chrome 启动后立刻退出, 退出码 ${String(code)}. 可能是 profile 目录被别的 Chrome 实例占用.`))
    })
  })

  if (result.handedOff) {
    child.unref()
    current = null
  } else {
    child.unref()
    current = child
  }

  return {
    executable,
    profileDir,
    args,
    pid: result.pid,
    handedOff: result.handedOff,
  }
}

/** 本插件拉起的 Chrome 是否还在跑. */
export function isChromeRunning(): boolean {
  return current !== null && current.exitCode === null && !current.killed
}

/** 记录"已交给外部实例", 让 isChromeRunning 反映真实情况. */
export function clearLaunchTracking(): void {
  current = null
}
