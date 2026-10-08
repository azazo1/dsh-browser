/**
 * 把桥层返回的数据渲染成给模型看的文本.
 *
 * 单独一个模块, 因为这些格式化纯属展示层的事, 与"通过桥做什么"无关; 混进工具定义里会让
 * 工具文件既描述协议又描述排版, 两边都读不清.
 */

import type { ConsoleEntry, ConsoleReadResult, EvaluateResult, QueryResult } from '../../shared/methods.js'
import { MAX_TEXT_CHARS } from '../../shared/protocol.js'

/**
 * 单条取值结果的展示上限.
 *
 * 属性表可能很长 (一个 <a> 带六七个属性很正常), 逐条全列会把上下文占满而信息增益很低.
 */
const MAX_ATTRIBUTES_PER_ITEM = 6

/**
 * 渲染取值结果.
 *
 * @param result 取值结果.
 * @returns 给模型的文本.
 */
export function formatQuery(result: QueryResult): string {
  const header = `标题: ${result.title}\n地址: ${result.url}\n匹配到 ${String(result.total)} 个元素`
    + (result.truncated ? `, 下面只列出前 ${String(result.items.length)} 个` : '')
  if (result.items.length === 0) {
    return `${header}\n\n没有匹配到任何元素. 请检查选择器是否写对了, 也可以用 browser_snapshot 看页面结构.`
  }
  const lines = result.items.map((item) => {
    const parts = [`[${String(item.index)}] <${item.tag}>`]
    if (item.text !== '') parts.push(item.text)
    const attributes = Object.entries(item.attributes).slice(0, MAX_ATTRIBUTES_PER_ITEM)
    if (attributes.length > 0) {
      parts.push(`(${attributes.map(([name, value]) => `${name}=${value}`).join(' ')})`)
    }
    return parts.join(' ')
  })
  return `${header}\n\n${lines.join('\n')}`
}

/**
 * 渲染求值结果.
 *
 * @param result 求值结果.
 * @param expression 被求值的表达式, 回显便于确认求的是什么.
 * @param world 执行世界.
 * @returns 给模型的文本.
 */
export function formatValue(result: EvaluateResult, expression: string, world: 'isolated' | 'main'): string {
  const label = world === 'main' ? '页面世界 (main)' : '扩展世界 (isolated)'
  const header = `表达式: ${expression}\n执行世界: ${label}\n结果类型: ${result.valueType}`
    + (result.truncated ? '\n(结果已被截断, 说明值太大或嵌套太深)' : '')
  return `${header}\n\n${result.value}`
}

/**
 * 渲染截图结果.
 *
 * 明确写出"下一步该做什么": 图片不在工具结果里, 模型看不到内容, 如果不说明, 它可能会
 * 以为截图失败了, 或者对着路径干瞪眼.
 *
 * @param shot 截图落盘信息.
 * @returns 给模型的文本.
 */
export function formatScreenshot(shot: { path: string, bytes: number, width: number, height: number, url: string }): string {
  return [
    `已截取 ${shot.url} 的当前视口, 存为 ${shot.path}`,
    `尺寸 ${String(shot.width)}x${String(shot.height)} 像素, ${String(shot.bytes)} 字节`,
    '',
    '图片没有直接放进工具结果, 所以你需要自己取: 若你能看图, 用 read_image 读上面这个路径; '
    + '若不能, 把路径告诉 user 由他查看.',
    '只截到了当前视口; 需要看更下面的内容时, 先 browser_scroll 再截一次.',
  ].join('\n')
}

/** 各级别在输出里的标记; other 额外带原始 type, 便于模型认出 dir/table 这类展示命令. */
const LEVEL_LABEL: Record<ConsoleEntry['level'], string> = {
  log: 'log',
  info: 'info',
  warning: 'warn',
  error: 'error',
  debug: 'debug',
  other: 'other',
}

/** 排版一条 console 条目. */
function formatConsoleEntry(entry: ConsoleEntry): string {
  const where = entry.url === null
    ? ''
    : ` (${entry.url}${entry.line === null ? '' : `:${String(entry.line)}`})`
  const typeNote = entry.level === 'other' ? ` [${entry.type}]` : ''
  return `[${LEVEL_LABEL[entry.level]}]${typeNote} ${entry.text}${where}`
}

/**
 * 渲染一次 console 读取 (或停止) 的结果.
 *
 * 条目按发生顺序排列, 不按级别重排: console 的价值在于时间线, 重排会把因果打乱. 总量
 * 超出 MAX_TEXT_CHARS 时从最旧的一端裁掉 (保留最新的), 因为最近发生的输出通常才是模型
 * 正在观察的东西.
 *
 * @param result 读取结果.
 * @returns 给模型的文本.
 */
export function formatConsole(result: ConsoleReadResult): string {
  if (result.entries.length === 0) {
    const suffix = result.interrupted !== null
      ? ` (${result.interrupted}; 需要继续请重新 action:"start")`
      : ''
    return `console 输出: 没有新输出${suffix}. ${result.note}`
  }
  // 从最新往回收, 在总预算内保留尽可能多的**最新**条目.
  const formatted = result.entries.map(formatConsoleEntry)
  const picked: string[] = []
  let used = 0
  for (let index = formatted.length - 1; index >= 0; index -= 1) {
    const line = formatted[index]
    if (line === undefined) break
    if (used + line.length + 1 > MAX_TEXT_CHARS && picked.length > 0) break
    picked.unshift(line)
    used += line.length + 1
  }
  const omitted = formatted.length - picked.length
  const lines = [
    `console 输出, ${result.note}`,
    '',
    ...picked,
  ]
  if (omitted > 0) lines.push(`\n(已省略最早的 ${String(omitted)} 条, 只保留最新的 ${String(picked.length)} 条)`)
  return lines.join('\n')
}
