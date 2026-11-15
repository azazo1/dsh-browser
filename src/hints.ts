/**
 * 状态的"下一步该做什么".
 *
 * 这段文本是模型行动的唯一依据: browser_status 之后它会照着办, 而不是再去猜. 所以两件事
 * 必须在这里说清:
 *
 *   - 浏览器还没启动, 与配置缺失是两件事. 待办要指向正确的那一件: 前者让模型调用工具,
 *     后者才让用户动手.
 *   - 文案直接从"此刻的状态"出发, 例如"浏览器还没启动. 调用 browser_open 会启动它", 不写
 *     "这不代表需要改配置"这类对照句 —— 那是知道前情的人才有的视角.
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
      ? '独立 profile 的 Chrome 已启动, 但扩展还没连上来: 请在那个窗口打开 chrome://extensions 加载扩展产物; 日常 Chrome 里已经连上的不算.'
      : '独立 profile 的 Chrome 还没启动. 调用 browser_open 会另开一个窗口并等扩展连上; 如果那个窗口里还没加载过扩展, 需要在 chrome://extensions 里加载一次.'])
  }
  if (input.autoLaunchChrome) {
    // 直接说现状与下一步. 不要写"这不代表需要改配置"这类对照句 —— 那是知道内情的人才有的
    // 视角, 第一次看到状态的模型只会觉得突兀, 而且它还得先推断"谁在说需要改配置".
    // 也不断言"浏览器还没启动": Chrome 可能开着, 只是扩展被禁用.
    return withLastError([
      '扩展还没连上来. 调用 browser_open 会启动浏览器 (已经在运行则直接复用) 并等扩展连上.',
      '如果之后仍然未连接, 到 chrome://extensions 确认 dsh Browser 处于启用状态.',
    ])
  }
  return withLastError([
    '扩展还没连上来. 请打开装了该扩展的那个 Chrome, 扩展会自动连上.',
    '如果浏览器已经开着, 到 chrome://extensions 确认 dsh Browser 处于启用状态.',
  ])
}
