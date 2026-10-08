/**
 * console 抓取工具.
 *
 * 单独一个文件而不并入 advanced.ts: 它的生命周期模型 (start/read/stop 三段式) 与那边
 * "一次调用一件事"的工具完全不同, 而且它经由 chrome.debugger 走 CDP, 是本插件里唯一
 * 一个需要向模型预告可见副作用的工具 (顶部提示条).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MAX_CONSOLE_READ_WAIT_MS } from '../../shared/protocol.js'
import { formatConsole } from './format.js'
import { runBrowser } from './shared.js'
import type { ToolDeps } from './shared.js'

/** 长轮询之外的调用超时余量; 覆盖桥往返与扩展侧的 drain/恢复开销. */
const READ_TIMEOUT_SLACK_MS = 5_000

/**
 * 构建 console 抓取工具.
 *
 * @param deps 工具依赖.
 * @returns 工具定义.
 */
export function consoleTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'browser_console',
    description:
      '获取当前绑定标签页的 console 输出 (log/info/warn/error/debug 与未捕获异常). '
      + '三段式用法: 先 action:"start" 开始抓取, 再执行想观察的页面操作 (browser_click / '
      + 'browser_evaluate 等), 然后 action:"read" 收取输出 (可带 wait_ms 等待新输出), '
      + '最后 action:"stop" 结束. 只收集开始之后的输出, 不含历史; 条目按发生顺序排列, '
      + '每条带级别与来源位置. '
      + '注意: 抓取期间浏览器顶部会出现"已开始调试此浏览器"提示条, 属正常现象, 网页脚本'
      + '检测不到, 但用户可以点掉它 —— 那会中断抓取, read 会报告原因; 用完务必 stop, '
      + '提示条随之消失. chrome:// 等内部页面无法抓取.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: '"start" 开始抓取 | "read" 读取自上次以来的输出 | "stop" 停止并返回剩余输出',
      },
      wait_ms: {
        type: 'integer',
        description: `仅 read: 缓冲为空时最多等待多少毫秒, 默认 0 (立即返回), 上限 ${String(MAX_CONSOLE_READ_WAIT_MS)}`,
      },
    },
    presentCall: (args) => ({ card: 'generic', title: `console ${args.action}` }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true, description: '本次返回的条目数' },
          capturing: { type: 'boolean', required: true, description: '读取时抓取是否仍在进行' },
          interrupted: { type: 'string', description: '抓取被中断的原因; 未中断时为 null' },
          text: { type: 'string', required: true, description: '给模型的完整文本' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      if (args.action === 'start') {
        const started = await resource.call('console.start', {}, exec.signal)
        return { count: 0, capturing: true, text: started.note }
      }
      if (args.action === 'stop') {
        const stopped = await resource.call('console.stop', {}, exec.signal)
        return {
          count: stopped.entries.length,
          capturing: stopped.capturing,
          // interrupted 声明为可选字段, 没有中断时干脆不出现, 避免多出 undefined 或 null.
          ...(stopped.interrupted === null ? {} : { interrupted: stopped.interrupted }),
          text: formatConsole(stopped),
        }
      }
      const waitMs = Math.min(Math.max(args.wait_ms ?? 0, 0), MAX_CONSOLE_READ_WAIT_MS)
      // 长轮询在扩展侧最多等 waitMs, 调用超时要给它留出余量.
      const result = await resource.call(
        'console.read',
        { waitMs },
        exec.signal,
        { timeoutMs: waitMs + READ_TIMEOUT_SLACK_MS },
      )
      return {
        count: result.entries.length,
        capturing: result.capturing,
        ...(result.interrupted === null ? {} : { interrupted: result.interrupted }),
        text: formatConsole(result),
      }
    }),
  })
}
