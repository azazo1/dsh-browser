/**
 * 浏览器运行时: 把配置, 安装状态, Chrome 启动, 桥连接串成一个可查询的整体.
 *
 * 会话所有权交给 `SessionResources` (来自 dsh 的实验性 browser-use 运行时包):
 * 它已经处理好了"每个活动会话一份资源, 会话释放时清理, 取消时不误伤别的会话"这些
 * 容易写错的细节.
 *
 * 标为 exclusive 是有意的: 分发给扩展的 profile 只有一个, 而扩展内部也只维持一个
 * "当前绑定标签页". 两个会话同时驱动同一个浏览器会互相踩, 所以第二个会话直接被
 * 拒绝, 而不是放进去造成难以复现的混乱.
 *
 * 注意 close() **不关掉 Chrome**: 这是一个持久 profile, 用户可能还要继续在里面
 * 浏览. 会话结束只释放对它的驱动权.
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionResources } from '@deepseek-ai/dsh-experimental-browser-use-runtime'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BridgeCallError, BridgeServer } from './bridge/server.js'
import { writeRendezvous } from './bridge/rendezvous.js'
import { launchChrome } from './chrome/launcher.js'
import { ChromeNotFoundError, locateChrome } from './chrome/locate.js'
import { assertUsableExtraArgs, resolvePaths } from './config.js'
import type { Config, ResolvedPaths } from './config.js'
import { inspectHost, installHost } from './native-host/install.js'
import type { HostInstallStatus } from './native-host/install.js'
import type { BrowserMethod, MethodArgs, MethodResult } from '../shared/methods.js'

/** 启动 Chrome 之后等待扩展连上桥的上限. */
const CONNECT_WAIT_MS = 12_000;

/** 浏览器资源: 工具通过它驱动扩展. */
export interface BrowserResource {
  /** 调用扩展的一个方法. */
  call<M extends BrowserMethod>(
    method: M,
    args: MethodArgs<M>,
    signal: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<MethodResult<M>>
}

/** 面向工具的完整状态快照. */
export interface BrowserStatus {
  /** Chrome 可执行文件路径与来源; 找不到时为 null. */
  chrome: { path: string, source: string } | null
  /** 定位失败原因. */
  chromeError: string | null
  /** 持久 profile 目录. */
  profileDir: string
  /** 数据根目录. */
  dataDir: string
  /** 连接组件的安装状态. */
  host: HostInstallStatus | null
  /** host 安装失败原因. */
  hostError: string | null
  /** 桥是否连上了扩展. */
  bridgeConnected: boolean
  /** 扩展清单版本. */
  extensionVersion: string | null
  /** 扩展当前绑定的标签页. */
  boundTabId: number | null
  /** 桥层的最近一次异常. */
  bridgeError: string | null
  /** 本次运行实际使用的启动参数. */
  launchArgs: string[] | null
  /** 为了让状态可用, 需要用户或模型做什么. */
  nextSteps: string[]
}

/**
 * 判断是否还需要由 dsh 自己启动浏览器.
 *
 * 单独抽出来是因为这条判断直接决定用户体验, 却又藏在启动流程里:
 *
 *   - 为 true 时要 spawn Chrome, 用户会看到一个新窗口 (首次使用, 或用户还没在浏览器
 *     里装好扩展);
 *   - 为 false 时**绝不能** spawn: 扩展已经连上桥, 说明用户自己那个浏览器里已经装好
 *     并启用了扩展, 再起一个空 profile 的窗口只会打断他, 而且那个窗口里没有扩展,
 *     对任务毫无帮助.
 *
 * @param bridgeConnected 扩展当前是否已连上桥.
 * @returns 是否需要启动浏览器.
 */
export function shouldLaunchBrowser(bridgeConnected: boolean): boolean {
  return !bridgeConnected
}

/** 浏览器没有按预期就绪时抛出. */
export class BrowserUnavailableError extends Error {
  /**
   * @param message 面向模型的中文说明, 必须包含可执行的下一步.
   */
  constructor(message: string) {
    super(message)
    this.name = 'BrowserUnavailableError'
  }
}

/** 把桥层的调用错误翻成给模型看的说明. */
export function describeBridgeError(error: unknown): string {
  const bridgeError = error as Partial<BridgeCallError>
  if (typeof bridgeError.code === 'string') {
    switch (bridgeError.code) {
      case 'no-binding':
        return '扩展没有连着 dsh. 请确认扩展已安装并在 chrome://extensions 中是启用状态, 然后点它的图标查看连接状态; 若显示未连接, 请到本插件的配置页点「安装连接组件」.'
      case 'stale-target':
        return `${bridgeError.message ?? ''} 请重新调用 browser_snapshot 获取最新结构后再操作.`
      case 'unknown-element':
        return `${bridgeError.message ?? ''} 编号来自最近一次 browser_snapshot, 请重新取快照确认编号.`
      case 'injection-blocked':
        return `${bridgeError.message ?? ''} 浏览器内部页面 (chrome:// 等) 无法被扩展操作, 这是 Chrome 的限制.`
      case 'timeout':
        return `${bridgeError.message ?? ''} 页面可能还在加载; 稍后重试或先用 browser_wait 等待特定文本.`
      default:
        return bridgeError.message ?? String(error)
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * 浏览器运行时.
 */
export class BrowserRuntime {
  private readonly resources: SessionResources<BrowserResource>
  private launchArgs: string[] | null = null
  private lastLaunchError: string | null = null
  private opening: Promise<void> | null = null

  /**
   * @param ctx 插件上下文.
   * @param config 插件配置.
   * @param bridge 桥服务.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly bridge: BridgeServer,
  ) {
    this.resources = new SessionResources<BrowserResource>(ctx, {
      label: 'dsh-browser',
      exclusive: true,
      open: async (agent, signal) => this.openResource(agent, signal),
    })
    ctx.effect(() => () => this.resources.dispose(), 'dsh-browser: session resources')
  }

  /** 当前解析出的路径. */
  get paths(): ResolvedPaths {
    return resolvePaths(this.config)
  }

  /** 扩展当前绑定的标签页 id; 未绑定时为 null. */
  get boundTabId(): number | null {
    return this.bridge.connectionState.boundTabId
  }

  /**
   * 取当前会话的浏览器资源; 必要时启动浏览器并等待扩展连上来.
   *
   * @param agent 发起调用的会话.
   * @param signal 取消信号.
   * @returns 可用的浏览器资源.
   */
  async acquire(agent: Agent, signal: AbortSignal): Promise<BrowserResource> {
    return this.resources.get(agent, signal)
  }

  /**
   * 在一个会话上串行执行一次浏览器操作.
   *
   * @param agent 发起调用的会话.
   * @param signal 取消信号.
   * @param operation 操作体.
   * @returns 操作结果.
   */
  async run<R>(agent: Agent, signal: AbortSignal, operation: (resource: BrowserResource) => Promise<R>): Promise<R> {
    return this.resources.run(agent, signal, operation)
  }

  /** 采集完整状态; 不启动浏览器, 只做只读探测. */
  async status(): Promise<BrowserStatus> {
    const paths = this.paths
    let chrome: BrowserStatus['chrome'] = null
    let chromeError: string | null = null
    try {
      const located = await locateChrome(this.config.chromePath.get())
      chrome = { path: located.path, source: located.source }
    } catch (error) {
      chromeError = error instanceof ChromeNotFoundError
        ? error.message
        : `探测 Chrome 失败: ${String(error)}`
    }

    let host: HostInstallStatus | null = null
    let hostError: string | null = null
    try {
      host = await inspectHost(paths)
    } catch (error) {
      hostError = error instanceof Error ? error.message : String(error)
    }

    const bridgeState = this.bridge.connectionState
    const nextSteps: string[] = []
    if (chrome === null) nextSteps.push('未找到 Google Chrome, 请在配置里填写 chromePath.')
    if (hostError !== null) nextSteps.push(`连接组件状态无法读取: ${hostError}`)
    else if (host !== null) nextSteps.push(...host.manualSteps)
    if (bridgeState.connected) nextSteps.length = 0
    else if (host?.manifestReady === true) {
      nextSteps.push('连接组件已就绪但扩展还没连上来: 请确认扩展已在 chrome://extensions 中加载并启用.')
    }
    if (this.lastLaunchError !== null) nextSteps.push(`上次启动 Chrome 失败: ${this.lastLaunchError}`)

    return {
      chrome,
      chromeError,
      profileDir: paths.profileDir,
      dataDir: paths.dataDir,
      host,
      hostError,
      bridgeConnected: bridgeState.connected,
      extensionVersion: bridgeState.extensionVersion,
      boundTabId: bridgeState.boundTabId,
      bridgeError: bridgeState.lastError,
      launchArgs: this.launchArgs,
      nextSteps,
    }
  }

  /**
   * 安装连接组件.
   * @returns 安装后的状态.
   */
  async install(): Promise<HostInstallStatus> {
    // 装完顺手把会合文件也刷新一次: 用户点这个按钮的意图就是"让扩展能连上",
    // 而扩展能不能连上取决于会合文件在不在, 不只是组件在不在.
    await this.publishRendezvous()
    return installHost(this.paths)
  }

  /**
   * 写会合文件, 告诉 native host 该连哪个端口.
   *
   * 这件事**必须在插件加载时就做**, 不能等到第一次 browser_open:
   *
   *   - 扩展被用户装好之后会立刻 `connectNative`, Chrome 随即把 host 进程拉起来;
   *   - host 一起床就要读会合文件拿地址, 读不到就退避重试;
   *   - 如果会合文件要等到某次 browser_open 才出现, 那么"用户装好扩展但还没开始用"
   *     的这段时间里, host 一直空转, 扩展侧只看到"连着但没反应".
   *
   * 之前正是这个时序问题: 用户点了"安装连接组件"、装好了扩展, host 也在跑, 但会合
   * 文件不存在, 于是链路整段不通, 而界面上看不出原因.
   *
   * @returns 写入完成时 resolve; 失败只记日志, 不阻塞插件加载.
   */
  async publishRendezvous(): Promise<void> {
    const paths = this.paths
    try {
      const written = await writeRendezvous(paths.rendezvousFile, this.ctx.webServer.port, this.bridge.token)
      this.ctx.logger.info(`dsh-browser: 已发布桥地址 ${written.wsUrl}`)
    } catch (error) {
      this.ctx.logger.warn(
        `dsh-browser: 写会合文件失败 (${paths.rendezvousFile}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 为一个会话创建资源: 检查组件, 写会合文件, 起浏览器, 等扩展连上来. */
  private async openResource(agent: Agent, signal: AbortSignal): Promise<{ value: BrowserResource, close: () => Promise<void> }> {
    if (this.config.installHostAutomatically.get()) {
      // 幂等, 重复执行只是覆盖同一批文件.
      await installHost(this.paths)
    }
    // 起浏览器之前先确认连接组件在不在. 否则会白开一个 Chrome, 再干等十几秒才报错,
    // 而真正该做的事情 (去配置页点一下) 其实现在就能告诉调用方.
    await this.assertHostReady()
    await this.ensureBrowser(signal)
    const bridge = this.bridge
    const agentLabel = agent.id
    this.ctx.logger.info(`dsh-browser: 会话 ${agentLabel} 取得浏览器驱动权`)
    return {
      value: {
        call: (method, args, callSignal, options) => bridge.call(method, args, {
          signal: callSignal,
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }),
      },
      close: async () => {
        // 刻意不关 Chrome: 这是用户的持久浏览器, 会话结束不该把它带走.
        this.ctx.logger.info(`dsh-browser: 会话 ${agentLabel} 释放浏览器驱动权 (Chrome 保持运行)`)
      },
    }
  }

  /**
   * 确认连接组件已就位, 否则抛出带下一步操作的错误.
   *
   * @throws BrowserUnavailableError 组件未安装或扩展产物缺失时抛出.
   */
  private async assertHostReady(): Promise<void> {
    let status: HostInstallStatus
    try {
      status = await inspectHost(this.paths)
    } catch (error) {
      throw new BrowserUnavailableError(
        `连接组件的状态无法读取: ${error instanceof Error ? error.message : String(error)}. `
        + '请在 dsh 的插件配置页打开本插件, 点「安装连接组件」.',
      )
    }
    if (!status.manifestReady) {
      throw new BrowserUnavailableError(
        '连接组件还没有安装 (native messaging 清单缺失). '
        + '请在 dsh 的「设置 -> 插件」里打开 dsh-browser 的配置页, 点「安装连接组件」, '
        + '然后按页面上的提示在 chrome://extensions 里加载一次扩展.',
      )
    }
    if (!status.extensionReady) {
      throw new BrowserUnavailableError(
        `扩展产物不在 ${status.extensionDir}. 请在插件配置页点「安装连接组件」重新落地产物.`,
      )
    }
  }

  /** 写会合文件并启动 Chrome, 然后等扩展连上桥. */
  private async ensureBrowser(signal: AbortSignal): Promise<void> {
    // 同一时刻只做一次启动, 并发的工具调用共享同一次尝试.
    this.opening ??= this.launchOnce(signal).finally(() => { this.opening = null })
    return this.opening
  }

  private async launchOnce(signal: AbortSignal): Promise<void> {
    const paths = this.paths

    // 扩展已经连着桥, 说明用户自己那个 Chrome 里已经装好并启用了扩展 —— 那就直接用
    // 它, 不要再起一个.
    //
    // 这一条不是优化而是必要的: 用户完全可能(而且现在就是)把扩展装在自己的日常
    // Chrome 里, 这时若还按"由 dsh 启动 Chrome"的路径走, 每次首次工具调用都会额外
    // 弹出一个空 profile 的 Chrome 窗口打断用户, 而且那个窗口里并没有扩展, 对任务
    // 毫无帮助.
    if (!shouldLaunchBrowser(this.bridge.connectionState.connected)) {
      this.ctx.logger.info('dsh-browser: 扩展已连接, 复用用户现有的浏览器, 不再启动新的 Chrome')
      return
    }

    const extraArgs = this.config.extraArgs.get()
    assertUsableExtraArgs(extraArgs)

    // 会合文件必须在 Chrome 起来之前写好: Chrome 一加载扩展, 扩展就会去连 native
    // host, 而 host 一起来就要读这个文件. 晚写会白白浪费一次重连退避.
    await writeRendezvous(paths.rendezvousFile, this.ctx.webServer.port, this.bridge.token)

    const located = await locateChrome(this.config.chromePath.get())
    let result
    try {
      result = await launchChrome({ executable: located.path, profileDir: paths.profileDir, extraArgs })
    } catch (error) {
      this.lastLaunchError = error instanceof Error ? error.message : String(error)
      throw new BrowserUnavailableError(`自动启动 Chrome 失败: ${this.lastLaunchError}`)
    }
    this.lastLaunchError = null
    this.launchArgs = result.args
    this.ctx.logger.info(
      result.handedOff
        ? 'dsh-browser: 已有一个 Chrome 实例在用同一个 profile, 请求已转交给它'
        : `dsh-browser: 已启动 Chrome (pid ${String(result.pid)})`,
    )

    if (this.bridge.connectionState.connected) return

    // 扩展尚未加载时这里必然等不到; 等不到不抛错, 让调用方拿到可执行的提示而不是
    // 一个超时异常 —— 首次安装的用户正好卡在这一步.
    const connected = await this.waitForBridge(signal, CONNECT_WAIT_MS)
    if (!connected) {
      const status = await this.status()
      const hint = status.host?.extensionReady === true
        ? `如果扩展还没装: 在 chrome://extensions 打开开发者模式, 点"加载已解压的扩展程序", 选中 ${paths.extensionDir}. `
        : '连接组件似乎还没装好, 请到本插件的配置页点「安装连接组件」. '
      throw new BrowserUnavailableError(
        `Chrome 已经启动, 但扩展没有在 ${String(CONNECT_WAIT_MS / 1_000)} 秒内连上来. `
        + hint
        + '装好后扩展会自动连接, 无需重启 dsh.',
      )
    }
  }

  /** 等桥报告已连接. */
  private async waitForBridge(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    if (this.bridge.connectionState.connected) return true
    return new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const timer = setTimeout(() => { finish(false) }, timeoutMs)
      const unsubscribe = this.bridge.subscribe((state) => {
        if (state.connected) finish(true)
      })
      const onAbort = (): void => { finish(false) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
