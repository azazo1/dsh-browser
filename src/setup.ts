/**
 * 插件是否"配好且够得着".
 *
 * 这个判断决定了**该不该弹授权请求**. 之前没有它, 于是出现两个咬在一起的坏体验:
 *
 *   1. 什么都还没配也会先弹一次 ask; 用户同意之后仍然什么都做不了, 因为缺令牌或缺连接组件;
 *   2. 同意之后插件会去启动一份独立 profile 的 Chrome, 而那份 profile 里**没有**扩展
 *      (用户把扩展装在自己的日常 Chrome 里), 所以桥永远连不上 —— 白弹一个窗口, 还要等十几秒
 *      才失败.
 *
 * 正确的次序是: 先确认"有一条能真正用上的路", 再问用户要不要用. 没有路的时候不该打扰用户,
 * 而应当把配置步骤讲清楚.
 *
 * 单独一个模块, 是为了让这段判定可以被直接测试: 它决定用户会不会被无意义地打扰, 而且
 * 涉及"够不够得着"这种跨几层的状态, 光读代码很难确认.
 */

import type { HostInstallStatus } from './native-host/install.js'

/** 判断就绪所需的输入. */
export interface SetupInput {
  /** 连接组件 (native messaging 清单) 是否已装好. */
  manifestReady: boolean
  /** 扩展产物是否已经落到数据目录. */
  extensionReady: boolean
  /** 扩展产物的目录, 供告诉用户该选哪个文件夹. */
  extensionDir: string
  /** dsh 侧是否已经填了配对令牌. */
  pairingConfigured: boolean
  /** 握手因配对失败被拒的原因; null 表示没有发生过. */
  pairingError: string | null
  /** 扩展当前是否连着桥 (也就是"现在能不能立刻用上"). */
  bridgeConnected: boolean
  /** 是否允许 dsh 启动它自己那份独立 profile 的 Chrome. */
  launchOwnChrome: boolean
}

/** 就绪判定结果. */
export interface SetupStatus {
  /** 是否已经可以真正用上浏览器. 为 false 时不该征求授权. */
  ready: boolean
  /** 还缺什么, 每项一句; 空数组表示都齐了. */
  gaps: string[]
  /** 给模型看的完整说明: 该把这些步骤讲给用户. */
  guide: string
}

/**
 * 列出还缺什么.
 *
 * 只列**真正挡住使用**的项, 不列可选项 (例如浏览器求值那个开关不开也能用别的工具).
 *
 * @param input 就绪判定输入.
 * @returns 缺失项清单; 空数组表示就绪.
 */
export function setupGaps(input: SetupInput): string[] {
  const gaps: string[] = []
  if (!input.manifestReady) {
    gaps.push('连接组件 (native messaging 清单) 还没安装')
  }
  if (!input.extensionReady) {
    gaps.push(`扩展产物不在 ${input.extensionDir}, 需要重新安装一次连接组件`)
  }
  if (!input.pairingConfigured) {
    gaps.push('dsh 侧还没填配对令牌')
  } else if (input.pairingError !== null) {
    // 配对失败时原因本身就要讲出来, 否则用户只知道"没配好"却不知道错在哪.
    gaps.push(`配对没通过: ${input.pairingError}`)
  }
  // "还没连上"只有在**没有别的路可走**时才算缺陷: 允许启动自带 Chrome 的情况下, 先启动再连接
  // 就是正常的流程, 若也算缺陷, 那条路会被自己的就绪检查挡住而永远走不通.
  if (!input.bridgeConnected && !input.launchOwnChrome) {
    gaps.push('扩展还没连上来: 需要在你自己的 Chrome 里打开这个扩展 (它装在哪个 Chrome 就打开哪个), 并确认它处于启用状态')
  }
  return gaps
}

/**
 * 写出配置步骤.
 *
 * 措辞面向**模型**: 它要把这些讲给用户, 而不是自己反复重试工具. 所以这里既说清"做什么",
 * 也明说"不要做什么".
 *
 * @param gaps 缺失项.
 * @param input 就绪判定输入, 用来给出具体路径.
 * @returns 说明文本.
 */
export function setupGuide(gaps: readonly string[], input: SetupInput): string {
  const lines = [
    '浏览器还没配置好, 所以现在不能操作浏览器, 也不会弹出授权请求.',
    '',
    '还缺:',
    ...gaps.map(gap => `- ${gap}`),
    '',
    '请把下面这些步骤讲给用户, 并等他做完再继续; 期间不要反复重试浏览器工具, 也不要以为换个工具就能绕过:',
  ]
  if (!input.manifestReady || !input.extensionReady) {
    lines.push('1. 打开 dsh 的「设置 -> 插件 -> dsh-browser」配置页, 点「安装连接组件」.')
  }
  lines.push(
    '2. 在 Chrome 地址栏打开 chrome://extensions, 打开右上角的开发者模式, 点「加载已解压的扩展程序」并选择这个文件夹:',
    `   ${input.extensionDir}`,
    '   (若这个扩展已经加载过, 只要点一下它的刷新按钮即可.)',
  )
  if (!input.pairingConfigured || input.pairingError !== null) {
    lines.push(
      '3. 点浏览器工具栏上的 dsh Browser 图标打开弹出面板, 复制里面的「配对令牌」.',
      '   把令牌粘贴回 dsh 的 dsh-browser 配置页里的 pairingToken 字段并保存; ',
      '   扩展会自动重连, 面板上会显示「dsh 已接受配对」.',
    )
  } else if (!input.bridgeConnected && !input.launchOwnChrome) {
    lines.push('3. 打开你安装了该扩展的那个 Chrome 并让它保持运行, 扩展会自动连上来.')
  }
  lines.push(
    '',
    '用户做完之后, 用 browser_status 确认「配对令牌」「扩展连接」两项都正常, 再开始操作页面.',
  )
  return lines.join('\n')
}

/**
 * 采集状态并给出就绪结论.
 *
 * @param input 就绪判定输入.
 * @returns 就绪状态与说明.
 */
export function evaluateSetup(input: SetupInput): SetupStatus {
  const gaps = setupGaps(input)
  return {
    ready: gaps.length === 0,
    gaps,
    guide: gaps.length === 0 ? '' : setupGuide(gaps, input),
  }
}

/**
 * 把安装状态折算成判定输入的一半.
 *
 * @param host 连接组件状态; null 表示读不到.
 * @param paths 解析出的路径.
 * @returns 与清单/产物相关的三个字段.
 */
export function hostParts(host: HostInstallStatus | null, paths: { extensionDir: string }): {
  manifestReady: boolean
  extensionReady: boolean
  extensionDir: string
} {
  return {
    manifestReady: host?.manifestReady === true,
    extensionReady: host?.extensionReady === true,
    // 读不到状态时仍然给出默认路径: 用户需要知道该选哪个文件夹, 而路径是确定的.
    extensionDir: host?.extensionDir ?? paths.extensionDir,
  }
}
