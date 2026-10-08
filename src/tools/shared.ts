/**
 * 工具层的共用件: 会话校验, 结果渲染, 错误归一化.
 *
 * 面向模型的文字有一条原则: 每次操作的结果都要说清"这一步到底发生了什么", 并且
 * 在失败时给出可自我纠正的下一步 (重新取快照, 换标签页, 先等待加载). 工具不该把
 * 底层错误原文直接丢给模型.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SnapshotResult, TabInfo } from '../../shared/protocol.js'
import { extensionLinkCounts } from '../../shared/status.js'
import { BrowserUnavailableError, describeBridgeError } from '../runtime.js'
import type { BrowserResource, BrowserRuntime } from '../runtime.js'

/** 每个工具都要的东西. */
export interface ToolDeps {
  /** 浏览器运行时. */
  runtime: BrowserRuntime
}

/**
 * 取发起调用的会话, 没有会话时给出明确错误.
 * @param exec 工具执行上下文.
 * @returns 发起会话.
 */
export function requireAgent(exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('browser_* 工具只能在 Agent 会话中调用 (缺少发起会话)')
  }
  return agent
}

/**
 * 在一个会话上执行浏览器操作, 并把各类失败翻译成给模型的说明.
 *
 * @param deps 工具依赖.
 * @param exec 工具执行上下文.
 * @param operation 操作体, 收到本会话的浏览器资源.
 * @returns 操作结果.
 */
export async function runBrowser<T>(
  deps: ToolDeps,
  exec: ToolRunContext,
  operation: (resource: BrowserResource) => Promise<T>,
): Promise<T> {
  const agent = requireAgent(exec)
  try {
    return await deps.runtime.run(agent, exec.signal, operation)
  } catch (error) {
    if (error instanceof BrowserUnavailableError) throw error
    throw new Error(describeBridgeError(error), { cause: error })
  }
}

/** 渲染标签页清单. */
export function formatTabs(tabs: readonly TabInfo[], boundTabId: number | null): string {
  if (tabs.length === 0) return '没有任何标签页.'
  const lines = [`共 ${String(tabs.length)} 个标签页:`]
  for (const tab of tabs) {
    const marks: string[] = []
    if (tab.id === boundTabId) marks.push('已绑定')
    if (tab.active) marks.push('前台')
    const suffix = marks.length === 0 ? '' : ` [${marks.join(', ')}]`
    lines.push(`- id=${String(tab.id)}${suffix} ${tab.title === '' ? '(无标题)' : tab.title}`)
    lines.push(`  ${tab.url}`)
  }
  if (boundTabId === null) {
    lines.push('当前没有绑定标签页: 页面操作前请先用 browser_select_tab 指定一个.')
  }
  return lines.join('\n')
}

/** 渲染页面快照: 先给元素编号清单, 再给正文. */
export function formatSnapshot(snapshot: SnapshotResult): string {
  const lines = [
    `标题: ${snapshot.title === '' ? '(无标题)' : snapshot.title}`,
    `地址: ${snapshot.url}`,
    `快照编号: ${snapshot.token} (点击与填入时需要带上它)`,
  ]
  lines.push('')
  if (snapshot.elements.length === 0) {
    lines.push('没有发现可交互元素; 这个页面可能是纯文本或还没渲染完.')
  } else {
    lines.push(`可交互元素 (${String(snapshot.elements.length)} 个, 用编号操作):`)
    for (const element of snapshot.elements) {
      const note = element.note === undefined ? '' : ` (${element.note})`
      lines.push(`[${String(element.index)}] ${element.role}: ${element.name === '' ? '(无名)' : element.name}${note}`)
    }
  }
  lines.push('')
  lines.push('正文:')
  lines.push(snapshot.text === '' ? '(页面没有可见文本)' : snapshot.text)
  if (snapshot.truncated) lines.push('\n(内容已截断, 可先用 browser_text 之外的定位方式缩小范围)')
  return lines.join('\n')
}

/**
 * 把状态对象渲染成一段给模型读的中文摘要.
 *
 * @param status 运行时状态.
 * @param selfId 发起查询的会话 id; 给出时会说明"本会话是否持有", 因为这决定了下一次
 *   浏览器调用会不会弹审批.
 * @returns 状态摘要.
 */
export function formatStatus(
  status: Awaited<ReturnType<BrowserRuntime['status']>>,
  selfId?: string,
): string {
  const lines: string[] = []
  lines.push(`Chrome: ${status.chrome === null ? `未找到 (${status.chromeError ?? '未知原因'})` : `${status.chrome.path} (来源: ${status.chrome.source})`}`)
  lines.push(`持久 profile: ${status.profileDir}`)
  lines.push(`数据目录: ${status.dataDir}`)
  if (status.launchArgs !== null) {
    lines.push(`本次启动参数: ${status.launchArgs.join(' ')}`)
  }
  if (status.hostError !== null) {
    lines.push(`连接组件: 状态读取失败 (${status.hostError})`)
  } else if (status.host === null) {
    lines.push('连接组件: 未知')
  } else {
    lines.push(`连接组件: ${status.host.manifestReady ? '已安装' : '未安装'} (清单 ${status.host.manifestPath})`)
    lines.push(`扩展 id: ${status.host.extensionId}`)
  }
  // 启动方式要在"扩展连接"之前讲清: 用户最担心的是"会不会突然冒出一个 Chrome 窗口",
  // 而这完全由这个开关决定.
  lines.push(`浏览器启动方式: ${status.launchStandaloneChromeProfile
    ? '启动独立 profile, 不复用日常 Chrome'
    : '不自行启动 Chrome, 只用你现有的浏览器 (launchStandaloneChromeProfile 未打开)'}`)
  // 配对状态放在扩展连接之前: 没配对时后面所有浏览器操作都会失败, 而原因就是这个, 所以
  // 用户应当先看到它.
  lines.push(status.pairingConfigured
    ? `配对令牌: 已配置${status.pairingError === null ? '' : ' (但最近一次握手被拒)'}`
    : '配对令牌: 尚未配置 —— 请打开浏览器扩展的弹出面板复制配对令牌, 填到本插件的 pairingToken 配置项')
  if (status.pairingError !== null) lines.push(`配对失败原因: ${status.pairingError}`)
  lines.push(`扩展连接: ${extensionLinkCounts(status)
    ? `已连接${status.extensionVersion === null ? '' : ` (扩展版本 ${status.extensionVersion})`}`
    : (status.launchStandaloneChromeProfile && status.launchArgs === null
      ? '独立 profile 尚未启动 (日常 Chrome 里的连接不算)'
      : '未连接')}`)
  const linked = extensionLinkCounts(status)
  if (status.launchStandaloneChromeProfile) {
    lines.push(`对端 profile: ${status.peerUserDataDir ?? '未探测到'}`)
  }
  // console 抓取是页面上唯一带可见副作用 (顶部提示条) 的能力, 状态里要能看出它开着没.
  if (status.consoleCapturing !== null && status.consoleCapturing !== undefined) {
    lines.push(`console 抓取: 进行中 (标签页 ${String(status.consoleCapturing.tabId)}, 顶部有调试提示条)`)
  }
  lines.push(`绑定标签页: ${!linked || status.boundTabId === null ? '无' : `id=${String(status.boundTabId)}`}`)
  // 独占: 同一时刻只有一个会话能驱动这个浏览器. 这里要说清两件事 —— 现在归谁, 以及
  // "本会话能不能直接用", 因为后者决定了下一次调用会不会弹审批.
  const holder = status.holderId === null ? '无会话持有' : `会话 ${status.holderId}`
  const mine = selfId === undefined
    ? ''
    : (status.holderId === selfId
        ? ' (本会话持有: 可以直接操作)'
        : ' (本会话未持有: 下一次浏览器调用会先弹审批申请)')
  lines.push(`驱动权: ${holder}${mine}`)
  // 求值能力取决于一个只能由用户手动打开的开关, 所以这里直接说清楚, 免得模型反复试
  // browser_evaluate 才发现不能用.
  if (linked && status.userScriptsAvailable !== null) {
    lines.push(`浏览器求值 (browser_evaluate): ${status.userScriptsAvailable
      ? '可用'
      : '未启用, 需要在扩展详情页打开 "Allow User Scripts" 开关; 期间可用 browser_query 取数据'}`)
  }
  if (status.bridgeError !== null) lines.push(`最近异常: ${status.bridgeError}`)
  if (status.nextSteps.length > 0) {
    lines.push('')
    lines.push('待办:')
    for (const step of status.nextSteps) lines.push(`- ${step}`)
  }
  return lines.join('\n')
}

/** 把未知类型参数收敛成整数, 非法时给出可读错误. */
export function toIntegerArg(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value)) throw new Error(`参数 ${name} 必须是整数, 收到 ${String(value)}`)
  return value
}
