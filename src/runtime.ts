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
import { evaluateSetup, hostParts } from './setup.js'
import type { SetupStatus } from './setup.js'
import type { Config, ResolvedPaths } from './config.js'
import { inspectHost, installHost } from './native-host/install.js'
import type { HostInstallStatus } from './native-host/install.js'
import type { BrowserMethod, MethodArgs, MethodResult } from '../shared/methods.js'

/** 启动 Chrome 之后等待扩展连上桥的上限. */
const CONNECT_WAIT_MS = 12_000;

/**
 * 判断"该用哪个浏览器"之前, 给正在进行的握手留的宽限.
 *
 * 配对校验通过之后才算 connected, 所以 socket 刚连上、hello 还在路上的那一瞬间状态是"未连接".
 * 不等一下就下结论, 会把一次正在成功的连接误判成"扩展没连上"而拒绝.
 */
const HANDSHAKE_GRACE_MS = 1_500;

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
  /** 浏览器求值所需的开关是否已打开; null 表示扩展没连上, 状态未知. */
  userScriptsAvailable: boolean | null
  /** 是否允许 dsh 启动它自己那份独立 profile 的 Chrome. */
  launchStandaloneChromeProfile: boolean
  /** dsh 侧是否已经配置了配对令牌. */
  pairingConfigured: boolean
  /** 握手因配对失败被拒时的原因; null 表示没有发生过. */
  pairingError: string | null
  /** 当前持有浏览器驱动权的会话 id; null 表示没有会话占用. */
  holderId: string | null
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
 * 决定这次要用哪个浏览器.
 *
 * 三种结果而不是"启动/不启动"两态, 因为第三种情况必须能说出理由:
 *
 *   - `launch`: 用户打开了独立 profile 开关. 这是一份与日常 Chrome 隔离的环境, 即使扩展
 *     已经在用户自己的浏览器里连着, 也不复用那个窗口 —— 打开这个开关就是选择另一份 profile.
 *   - `reuse`: 没开独立 profile, 且扩展已经连着桥. 这时用的就是用户日常那个 Chrome.
 *   - `refuse`: 没开独立 profile, 也没连上. 这时必须说清"下一步该做什么", 因为用户能做的
 *     事情(打开自己的 Chrome / 打开 launchStandaloneChromeProfile)与"什么都不做等重试"完全不同.
 *
 * @param input 判定输入.
 * @param input.bridgeConnected 扩展是否已连上桥.
 * @param input.launchStandaloneChromeProfile 是否启动 dsh 自带的独立 profile Chrome.
 * @returns 决策结果.
 */
export function launchDecision(input: { bridgeConnected: boolean, launchStandaloneChromeProfile: boolean }):
  { kind: 'reuse' } | { kind: 'launch' } | { kind: 'refuse', reason: string } {
  // 独立 profile 优先: 这个开关的语义就是"不要用用户日常那个 Chrome".
  if (input.launchStandaloneChromeProfile) return { kind: 'launch' }
  if (input.bridgeConnected) return { kind: 'reuse' }
  return {
    kind: 'refuse',
    reason: '扩展还没有连上来, 而本插件被配置为不自行启动 Chrome (launchStandaloneChromeProfile 未打开). '
      + '这通常意味着需要用户打开他自己的那个 Chrome —— 扩展装在哪个 Chrome 里, 就打开哪个, '
      + '并确认它在 chrome://extensions 里是启用状态; 扩展连上来之后重试即可. '
      + '如果本来就打算让 dsh 用它自己那份独立 profile 的 Chrome, 请打开配置里的 launchStandaloneChromeProfile; '
      + '注意那份 profile 需要用户单独加载一次扩展, 否则同样连不上.',
  }
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

/**
 * 把桥层的调用错误翻成给模型看的说明.
 *
 * 各分支只补"扩展侧说不出来"的那部分: 扩展知道发生了什么, 但不知道调用方该怎么纠正,
 * 所以这里加的是下一步动作. 扩展侧已经说过的原因不重复 —— 早先 injection-blocked
 * 分支把"内部页面不能操作"说了两遍 (扩展的 blockedReason 里已经讲过), 读起来像两句
 * 同一句话, 也没有多出任何信息.
 */
export function describeBridgeError(error: unknown): string {
  const bridgeError = error as Partial<BridgeCallError>
  const detail = bridgeError.message ?? ''
  if (typeof bridgeError.code === 'string') {
    switch (bridgeError.code) {
      case 'no-binding':
        return '扩展没有连着 dsh. 请确认扩展已安装并在 chrome://extensions 中是启用状态, 然后点它的图标查看连接状态; 若显示未连接, 请到本插件的配置页点「安装连接组件」.'
      case 'stale-target':
        return `${detail} 请重新调用 browser_snapshot 获取最新结构后再操作.`
      case 'unknown-element':
        return `${detail} 编号来自最近一次 browser_snapshot, 请重新取快照确认编号.`
      case 'injection-blocked':
        // 扩展已经说明了是哪种页面以及为什么, 这里不再复述原因.
        return detail
      case 'pairing-rejected':
        // 原因 (为什么被拒, 该怎么改) 全在 detail 里, 原样透出即可.
        return detail === '' ? String(error) : detail
      case 'timeout':
        return `${detail} 页面可能还在加载; 稍后重试或先用 browser_wait 等待特定文本.`
      default:
        return detail === '' ? String(error) : detail
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * 造一份浏览器资源.
 *
 * 资源是"能驱动浏览器"的凭据, 所以它的每一次调用都要重新确认持有者仍然被授予 —— 授权可能
 * 在资源还活着的时候被转给别的会话, 那时旧资源必须立刻失效, 而不是继续替旧会话操作页面.
 *
 * 单独抽成函数是为了让这条守卫可以被直接测试: 否则它只存在于 `openResource` 内部, 而要让
 * `openResource` 跑通就得准备好真的 native messaging 清单, 测试会很脆.
 *
 * @param input 构造输入.
 * @param input.bridge 桥.
 * @param input.assertGranted 确认持有者仍被授予; 不满足时抛错.
 * @param input.onClose 资源被释放时的回调.
 * @returns 资源与其释放入口.
 */
export function makeResource(input: {
  bridge: BridgeServer
  assertGranted: () => void
  onClose: () => void
}): { value: BrowserResource, close: () => Promise<void> } {
  return {
    value: {
      // 标成 async 是有意的: 这样"未授予"会变成 rejected promise, 而不是同步抛出. 声明上
      // 返回的就是 Promise, 调用方 (通常写 `await resource.call(...)`) 两边都能接住, 但
      // 让失败走 promise 通道更符合这个签名, 也不会在 `expect(...)` 一类只接 promise 的
      // 写法里变成意外抛错.
      call: async (method, args, callSignal, options) => {
        input.assertGranted()
        return await input.bridge.call(method, args, {
          signal: callSignal,
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })
      },
    },
    close: async () => { input.onClose() },
  }
}

/**
 * 浏览器运行时.
 */
export class BrowserRuntime {
  private readonly resources: SessionResources<BrowserResource>
  /**
   * 当前被授予浏览器驱动权的会话.
   *
   * 只有一个会话能持有它, 这是硬约束: 分发给扩展的 profile 只有一个, 扩展内部也只维持
   * 一个"当前绑定标签页", 两个会话同时驱动会互相踩.
   *
   * 授予的转移**必须经过用户审批** (见 src/index.ts 里的 tools/pre-execute 钩子), 所以
   * 这里只负责记住状态, 不自己做仲裁.
   */
  private granted: Agent | null = null

  /** 已经登记过"作用域回收时放弃授予"的会话, 避免重复登记. */
  private readonly grantWatchers = new WeakSet<Agent>()
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
      // 刻意关掉库自带的独占: 它只认"先到先得", 一旦某个会话取得就不再让出, 也就没法
      // 把浏览器交给另一个会话. 换手由下面这层"授予"来仲裁 —— 授予的转移必须经过用户
      // 审批, 而不是库里的先到先得.
      exclusive: false,
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
   * 在一个会话上串行执行一次浏览器操作.
   *
   * @param agent 发起调用的会话.
   * @param signal 取消信号.
   * @param operation 操作体.
   * @returns 操作结果.
   */
  async run<R>(agent: Agent, signal: AbortSignal, operation: (resource: BrowserResource) => Promise<R>): Promise<R> {
    // 只有被授予的会话能驱动浏览器. 授予不会在这里自动发生 —— 它必须由审批钩子完成,
    // 否则就成了"静默取得", 而用户要的恰恰是"每次换手都让用户决定".
    if (this.granted !== agent) throw this.notGrantedError()
    return this.resources.run(agent, signal, operation)
  }

  /**
   * 生成"这个会话还没有驱动权"的错误.
   *
   * 措辞刻意指向**下一步怎么做**, 而不是只说被拒绝: 用户与模型都需要知道"再发起一次调用
   * 就会弹审批".
   *
   * @returns 错误实例.
   */
  private notGrantedError(): Error {
    const occupant = this.granted
    return new BrowserUnavailableError(
      occupant === null
        ? '本会话还没有取得浏览器. 请直接用浏览器工具发起一次调用 —— 那次调用会先征求用户同意, 同意后即可使用.'
        : `浏览器现在归会话 ${occupant.id} 使用. 请直接发起调用: 那次调用会征求用户同意, 同意后浏览器会交到本会话手上.`,
    )
  }

  /** 当前被授予驱动权的会话 id; null 表示没有会话持有. */
  get grantedId(): string | null {
    return this.granted?.id ?? null
  }

  /**
   * 判断一个会话此刻是否持有驱动权.
   *
   * @param agent 会话.
   * @returns 持有为 true.
   */
  holdsBrowser(agent: Agent): boolean {
    return this.granted === agent
  }

  /**
   * 把驱动权授予一个会话; 若原本属于别人, 则从对方手上收回.
   *
   * 调用前必须已经取得用户同意 (审批钩子或会话 Tab 上的点击), 本方法不自行判断.
   *
   * @param agent 要授予的会话.
   */
  grant(agent: Agent): void {
    if (this.granted === agent) return
    const previous = this.granted
    this.granted = agent
    if (previous !== null) {
      this.ctx.logger.info(`dsh-browser: 浏览器驱动权由会话 ${previous.id} 交给会话 ${agent.id}`)
    }
    // 会话结束时自动放弃: 否则一个已经消失的会话会永远占着, 后面谁也用不了.
    //
    // 登记在会话自己的作用域上, 因为作用域回收正是"这个会话结束了"的准确信号 ——
    // 每轮对话结束不是, 请求结束也不是.
    if (!this.grantWatchers.has(agent)) {
      this.grantWatchers.add(agent)
      agent.ctx.effect(() => () => {
        if (this.granted === agent) {
          this.granted = null
          this.ctx.logger.info(`dsh-browser: 会话 ${agent.id} 已结束, 浏览器驱动权回到无人持有`)
        }
      }, 'dsh-browser: browser grant')
    }
  }

  /**
   * 主动放弃驱动权.
   *
   * @param agent 要放弃的会话.
   * @returns 这次调用是否真的放掉了 (不是持有者就没什么可放的).
   */
  release(agent: Agent): boolean {
    if (this.granted !== agent) return false
    this.granted = null
    this.ctx.logger.info(`dsh-browser: 会话 ${agent.id} 主动释放浏览器驱动权`)
    return true
  }

  /**
   * 判断现在是否"配好且够得着".
   *
   * 这是**该不该征求授权**的前置条件: 没有一条能真正用上的路时, 问用户毫无意义 —— 他同意
   * 之后也一样用不了, 而那个弹窗本身就是一次打扰.
   *
   * @returns 就绪状态与(不就绪时的)配置说明.
   */
  async setup(): Promise<SetupStatus> {
    const status = await this.status()
    return evaluateSetup({
      ...hostParts(status.host, this.paths),
      pairingConfigured: status.pairingConfigured,
      pairingError: status.pairingError,
      bridgeConnected: status.bridgeConnected,
      launchStandaloneChromeProfile: this.config.launchStandaloneChromeProfile.get(),
    })
  }

  /** 采集完整状态; 不启动浏览器, 只做只读探测. */
  async status(): Promise<BrowserStatus> {
    // 配置页的"刷新状态"走这里. 配对可能在握手之后被改掉, 不先复查的话界面仍显示已连接.
    this.bridge.syncPairing()
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
    const standalone = this.config.launchStandaloneChromeProfile.get()
    const launchedStandalone = standalone && this.launchArgs !== null
    if (bridgeState.pairingError !== null) {
      // 配对失败是当前挡住使用的原因; 再写"去装扩展"会把用户带偏.
      nextSteps.length = 0
      nextSteps.push(`配对没通过: ${bridgeState.pairingError}`)
    } else if (standalone && !launchedStandalone) {
      // 日常 Chrome 连着也不算: 打开这个开关就是选择另一份 profile.
      nextSteps.push(
        '独立 profile 尚未启动. 第一次使用时会另开窗口, 不会复用日常 Chrome; '
        + '请在那个窗口打开 chrome://extensions, 加载扩展产物.',
      )
    } else if (bridgeState.connected) nextSteps.length = 0
    else if (standalone) {
      nextSteps.push(
        '独立 profile 已启动但扩展还没连上来: 请在那个窗口打开 chrome://extensions, '
        + '加载扩展产物. 日常 Chrome 里已经连上的不算.',
      )
    } else if (host?.manifestReady === true) {
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
      userScriptsAvailable: bridgeState.userScriptsAvailable,
      launchStandaloneChromeProfile: this.config.launchStandaloneChromeProfile.get(),
      pairingConfigured: this.config.pairingToken.get() !== '',
      pairingError: bridgeState.pairingError,
      boundTabId: bridgeState.boundTabId,
      bridgeError: bridgeState.lastError,
      launchArgs: this.launchArgs,
      holderId: this.grantedId,
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
   * 之前正是这个时序问题: 用户点了"安装连接组件", 装好了扩展, host 也在跑, 但会合
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

  /**
   * 为一个会话创建资源: 检查组件, 写会合文件, 起浏览器, 等扩展连上来.
   *
   * **这里是浏览器侧唯一的收口**: 启动 Chrome 与产出"可调用桥的资源"都只发生在此. 所以
   * 授予检查也放在这里 —— 只要不满足, 就既不会起浏览器, 也不会得到能驱动它的东西, 无论
   * 调用方是从哪条路走进来的. 放在每个工具里各查一遍是不够的: 那样任何一条新增或遗漏的
   * 路径都会变成绕过. (`run()` 里还查一次, 只是为了给出更能照着做的错误信息.)
   *
   * @param agent 发起调用的会话.
   * @param signal 取消信号.
   * @returns 资源与其释放入口.
   * @throws BrowserUnavailableError 该会话尚未被授予驱动权时抛出.
   */
  private async openResource(agent: Agent, signal: AbortSignal): Promise<{ value: BrowserResource, close: () => Promise<void> }> {
    if (this.granted !== agent) throw this.notGrantedError()
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
    this.ctx.logger.info(`dsh-browser: 会话 ${agentLabel} 完成浏览器资源准备`)
    return makeResource({
      bridge,
      // 每次调用都重新问一次"现在是否仍被授予", 而不是在构造时定下来: 资源可能在授权被
      // 转走之后还活着, 那时它必须立刻失效, 而不是继续替旧会话驱动浏览器.
      assertGranted: () => { if (this.granted !== agent) throw this.notGrantedError() },
      onClose: () => {
        this.ctx.logger.info(`dsh-browser: 会话 ${agentLabel} 释放浏览器驱动权 (Chrome 保持运行)`)
      },
    })
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

    const standalone = this.config.launchStandaloneChromeProfile.get()
    // 复用路径才需要握手宽限: 独立 profile 不看现有连接, 等它只是把日常 Chrome 的 hello
    // 当成"已经连上".
    const bridgeConnected = standalone
      ? this.bridge.connectionState.connected
      : await this.waitForBridge(signal, HANDSHAKE_GRACE_MS)
    const decision = launchDecision({
      bridgeConnected,
      launchStandaloneChromeProfile: standalone,
    })
    if (decision.kind === 'reuse') {
      this.ctx.logger.info('dsh-browser: 扩展已连接, 复用用户现有的浏览器, 不启动独立 profile')
      return
    }
    if (decision.kind === 'refuse') throw new BrowserUnavailableError(decision.reason)

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

    // 启动前日常 Chrome 可能已经连着. 那条连接必须让位, 否则下面会立刻当成"已经连上"
    // 而开始操作用户自己的窗口.
    if (bridgeConnected) this.bridge.dropLive('独立 profile 不复用已有连接')

    // 扩展尚未加载时这里必然等不到; 等不到不抛错, 让调用方拿到可执行的提示而不是
    // 一个超时异常 —— 首次安装的用户正好卡在这一步.
    const connected = await this.waitForBridge(signal, CONNECT_WAIT_MS)
    if (!connected) {
      const status = await this.status()
      const hint = status.host?.extensionReady === true
        ? `请在独立 profile 那个窗口打开 chrome://extensions, 点"加载已解压的扩展程序", 选中 ${paths.extensionDir}. 日常 Chrome 里已经装过的不算. `
        : '连接组件似乎还没装好, 请到本插件的配置页点「安装连接组件」. '
      throw new BrowserUnavailableError(
        `独立 profile 的 Chrome 已经启动, 但扩展没有在 ${String(CONNECT_WAIT_MS / 1_000)} 秒内连上来. `
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
