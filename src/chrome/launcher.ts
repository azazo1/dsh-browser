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
 *   --user-data-dir        指向 dsh 自己的持久 profile (启动独立 profile 时才有)
 *   --no-first-run         跳过首次运行引导
 *   --no-default-browser-check  跳过"设为默认浏览器"提示
 *
 * 启动用户日常那个 Chrome 时这三条一个都不加: 那份 profile 不是本插件管的, 加任何参数都可能
 * 把它变成另一份环境, 而"扩展已经装在日常 Chrome 里"正是那条路能自动连上的前提. 在 macOS 上
 * 还改用 `open -a`, 让它表现得像用户自己点开浏览器那样 (见 launchTarget).
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
  /** profile 目录; 启动用户日常 Chrome 时为 null. */
  profileDir: string | null
  /** 实际使用的参数. */
  args: string[]
  /** 本次 spawn 出来的进程 id; 交给已有实例时为 null. */
  pid: number | null
  /** 是不是"已有实例在跑, 本次只是把窗口带到前台". */
  handedOff: boolean
}

/** 当前被本插件拉起的 Chrome 进程; 交给已有实例时为 null. */
let current: ChildProcess | null = null

/**
 * 组装启动参数.
 *
 * @param profileDir 要用的 profile 目录; null 表示启动用户日常那个 Chrome.
 * @param extraArgs 用户配置的额外参数.
 * @returns 参数表.
 */
export function buildLaunchArgs(profileDir: string | null, extraArgs: readonly string[]): string[] {
  // null 表示"启动用户日常那个 Chrome". 此时刻意不带 --user-data-dir: 带上就等于另起一份
  // 空白环境, 扩展与登录态都不会跟过来, 这正是"白开一个窗口然后连不上"的来源.
  // --no-first-run / --no-default-browser-check 也只对全新 profile 有意义, 日常那份不该被
  // 这些参数改写行为, 所以一概不加.
  if (profileDir === null) return [...extraArgs]
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...extraArgs,
  ]
}

/**
 * 从 Chrome 可执行文件路径推出它的 .app 包路径.
 *
 * 只有 macOS 的 Chrome 装在 app 包里; PATH 里的 google-chrome 之类推不出来, 返回 null,
 * 那时退回直接 spawn.
 *
 * @param executable 可执行文件路径.
 * @returns app 包路径; 推不出时为 null.
 */
export function appBundleOf(executable: string): string | null {
  const marker = '.app/Contents/MacOS/'
  const index = executable.indexOf(marker)
  if (index < 0) return null
  return executable.slice(0, index + '.app'.length)
}

/**
 * 组装"用哪个命令启动".
 *
 * 启动用户日常那个 Chrome 时:
 *   - macOS 走 `open -a <App>`. 这才是"启动这个 app" —— app 已在运行时它只是把窗口带到前台,
 *     而不是每调用一次就多开一个空窗口 (扩展没连上时我们可能反复尝试, 那会变成一串空窗口).
 *   - 其它平台直接 spawn 可执行文件, 它等价于从开始菜单 / 应用列表打开: Windows 上 spawn
 *     chrome.exe 与用户自己双击没有区别, 而走 `cmd /c start` 会丢掉启动失败的错误信息.
 *
 * 独立 profile 在任何平台都直接 spawn, 因为要由本进程传入 --user-data-dir.
 *
 * @param executable Chrome 可执行文件.
 * @param profileDir profile 目录; null 表示启动日常那个.
 * @param args 已经组装好的 Chrome 参数.
 * @returns 要执行的命令与参数.
 */
export function launchTarget(executable: string, profileDir: string | null, args: readonly string[]):
  { file: string, args: string[] } {
  if (profileDir === null && process.platform === 'darwin') {
    const app = appBundleOf(executable)
    if (app !== null) {
      return { file: 'open', args: args.length === 0 ? ['-a', app] : ['-a', app, '--args', ...args] }
    }
  }
  return { file: executable, args: [...args] }
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
  profileDir: string | null
  extraArgs: readonly string[]
}): Promise<LaunchResult> {
  const { executable, profileDir, extraArgs } = options
  // 只有独立 profile 才需要预先建目录; 日常那份由 Chrome 自己管.
  if (profileDir !== null) await mkdir(profileDir, { recursive: true, mode: 0o700 })
  const args = buildLaunchArgs(profileDir, extraArgs)
  const command = launchTarget(executable, profileDir, args)

  const child = spawn(command.file, command.args, {
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
      else {
        reject(new Error(
          `Chrome 启动后立刻退出, 退出码 ${String(code)}.`
          + (profileDir === null
            ? ' 请确认 Chrome 安装完整.'
            : ' 可能是 profile 目录被别的 Chrome 实例占用.'),
        ))
      }
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
