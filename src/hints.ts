/**
 * 状态的"下一步该做什么".
 *
 * 这段文本是模型行动的唯一依据: browser_status 之后它会照着办, 而不是再去猜. 所以两件事
 * 必须在这里说清:
 *
 *   - 扩展没连上**不等于**配置缺失. 浏览器没启动时, 待办应当是"直接再调用一次工具",
 *     而不是"去 chrome://extensions 加载扩展" —— 后者会让人白折腾一遍, 而扩展其实装得好好的.
 *   - 只有真正挡住链路的东西 (找不到 Chrome, 组件没装, 配对失败) 才排在最前面, 并且只排它们.
 *
 * 抽成纯函数是为了能直接测: 这段文案出错时, 表现是"模型让用户去做无用的事", 从代码上
 * 看不出来.
 */

/** 连接组件里与"下一步"有关的那部分. */
export interface NextStepsHost {
  /** 清单与包装脚本是否就位. */
  manifestReady: boolean
  /** 扩展产物是否就位. */
  extensionReady: boolean
  /** 安装组件需要用户动手的步骤. */
  manualSteps: readonly string[]
}

/** 生成待办所需的输入. */
export interface NextStepsInput {
  /** 是否找到了 Chrome. */
  chromeFound: boolean
  /** 连接组件状态读取失败的原因. */
  hostError: string | null
  /** 连接组件状态; 读不到为 null. */
  host: NextStepsHost | null
  /** 扩展是否已经连上 (按当前独立/日常口径). */
  linked: boolean
  /** 是否启动独立 profile 的 Chrome. */
  launchStandaloneChromeProfile: boolean
  /** 扩展没连上时是否按需自动启动. */
  autoLaunchChrome: boolean
  /** 本次运行是否已经拉起过浏览器. */
  launched: boolean
  /** 上次启动失败的原因. */
  lastLaunchError: string | null
  /** 配对失败原因; 非空时它挡住一切. */
  pairingError: string | null
}

/**
 * 生成给模型看的待办.
 *
 * @param input 判定输入.
 * @returns 待办清单; 空数组表示现在可以直接用.
 */
export function browserNextSteps(input: NextStepsInput): string[] {
  const withLastError = (steps: string[]): string[] => input.lastLaunchError === null
    ? steps
    : [...steps, `上次启动 Chrome 失败: ${input.lastLaunchError}`]

  // 配对失败挡住一切: 这时再讲"去加载扩展"只会把用户带偏.
  if (input.pairingError !== null) return withLastError([`配对没通过: ${input.pairingError}`])

  const componentsMissing = input.hostError !== null
    || (input.host !== null && (!input.host.manifestReady || !input.host.extensionReady))

  // 先讲真正挡住链路的东西. 这些没解决之前, "浏览器没启动"之类的说明都无从谈起.
  if (!input.chromeFound || componentsMissing) {
    const blockers: string[] = []
    if (!input.chromeFound) blockers.push('未找到 Google Chrome, 请在配置里填写 chromePath.')
    if (input.hostError !== null) blockers.push(`连接组件状态无法读取: ${input.hostError}`)
    else if (componentsMissing && input.host !== null) blockers.push(...input.host.manualSteps)
    return withLastError(blockers)
  }

  if (input.linked) return withLastError([])

  // 到这里: Chrome 在, 组件齐, 但扩展还没连上.
  if (input.launchStandaloneChromeProfile) {
    return withLastError([input.launched
      ? '独立 profile 的 Chrome 已经启动, 但扩展没连上来: 请在那个窗口打开 chrome://extensions 加载扩展产物; 日常 Chrome 里已经连上的不算.'
      : '独立 profile 的 Chrome 还没启动: 调用 browser_open 即可, 它会另开一个窗口. 若那个窗口里还没加载过扩展, 请在 chrome://extensions 里加载一次.'])
  }
  if (input.autoLaunchChrome) {
    // 这条是关键: 未连接时不要先去改配置, 再调用一次就够了. 必须点名 browser_open, 因为
    // browser_status 是只读的, 再查多少次都不会启动浏览器 —— 那会变成原地打转.
    return withLastError([
      '扩展还没连上, 但这不代表需要改配置: 调用 browser_open 即可 (browser_status 只读, 再查也不会启动浏览器), 插件会自动启动你日常那个 Chrome, 让里面的扩展连上来.',
      '若自动启动之后仍然连不上, 再到 chrome://extensions 确认 dsh Browser 处于启用状态.',
    ])
  }
  return withLastError([
    '扩展还没连上: 请打开装了该扩展的那个 Chrome 并保持运行, 扩展会自动连上.',
    '如果浏览器已经开着, 到 chrome://extensions 确认 dsh Browser 处于启用状态.',
  ])
}
