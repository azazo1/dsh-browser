/**
 * 会话级工具: 启动浏览器, 查询状态, 查看与选择标签页.
 *
 * 这些工具不碰页面内容, 只负责"把浏览器带到一个可操作的状态", 以及告诉调用方
 * 当前到底能不能用.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DEFAULT_CALL_TIMEOUT_MS } from '../../shared/protocol.js'
import { formatStatus, formatTabs, requireAgent, runBrowser } from './shared.js'
import type { ToolDeps } from './shared.js'

/**
 * 构造会话级工具集.
 * @param deps 工具依赖.
 * @returns 待注册的工具定义.
 */
export function sessionTools(deps: ToolDeps): ToolDefinition[] {
  const open = defineTool({
    name: 'browser_open',
    description:
      '确保浏览器平面可用. 默认不自行打开 Chrome, 只用扩展已经连上的那个浏览器; '
      + '打开 launchStandaloneChromeProfile 后始终启动独立 profile, 即使日常 Chrome 里扩展已经连着也不复用. '
      + '浏览器同一时刻只服务一个会话, 所以每个会话第一次用它时都会弹一次审批, 由用户决定现在归谁; '
      + 'justification 参数会展示给用户, 调用前请想好一句能让人看懂的话, 不要写"用户要求打开浏览器"这类空话. '
      + '交出驱动权用 browser_release.',
    parameters: {
      justification: {
        type: 'string',
        required: true,
        description: '给用户看的一句话理由: 为什么这个会话需要打开浏览器. 首次启动的审批弹窗会原样展示这句话.',
      },
      url: {
        type: 'string',
        description: '可选: 浏览器就绪后打开这个地址. 省略则只确保浏览器可用, 不改动任何标签页.',
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '打开 dsh 的 Chrome',
      rawInput: args.url === undefined || args.url === '' ? { justification: args.justification } : { justification: args.justification, url: args.url },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true, description: '扩展是否已连上, 可以开始操作' },
          chromePath: { type: 'string', required: true, description: '使用的 Chrome 可执行文件路径' },
          profileDir: { type: 'string', required: true, description: '持久 profile 目录' },
          text: { type: 'string', required: true, description: '给模型的状态摘要' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => {
      // 先拿资源 (这会完成组件安装与 Chrome 启动, 并在扩展未连上时给出可执行的提示).
      const status = await runBrowser(deps, exec, async (resource) => {
        if (args.url !== undefined && args.url !== '') {
          await resource.call('tabs.open', { url: args.url }, exec.signal)
        } else {
          // 不发页面调用也要确认通道通了, 用一次标签页列举当作握手探测.
          await resource.call('tabs.list', {}, exec.signal, { timeoutMs: DEFAULT_CALL_TIMEOUT_MS })
        }
        return deps.runtime.status()
      })
      const lines = ['Chrome 已就绪, 扩展通道通畅.', '', formatStatus(status)]
      return {
        ready: status.bridgeConnected,
        chromePath: status.chrome?.path ?? '(未找到)',
        profileDir: status.profileDir,
        text: lines.join('\n'),
      }
    },
  })

  const status = defineTool({
    name: 'browser_status',
    description:
      '查询浏览器平面的完整状态: Chrome 二进制位置, 持久 profile 目录, 连接组件是否装好, '
      + '扩展是否连上, 当前绑定了哪个标签页, 以及为了让状态可用还需要做什么. '
      + '连接出问题, 或不确定能不能操作时先用它, 而不是盲目重试页面工具.',
    parameters: {},
    presentCall: () => ({ card: 'generic', title: '查询浏览器状态' }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true, description: '是否可以立即执行页面操作' },
          text: { type: 'string', required: true, description: '完整状态摘要' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (_args, exec) => {
      const current = await deps.runtime.status()
      // 绑定了标签页也不代表能操作: 还要扩展连着.
      const ready = current.chrome !== null && current.host?.manifestReady === true && current.bridgeConnected && current.pairingError === null
      // 带上本会话身份, 让摘要能回答"我现在能不能直接用"这个最要紧的问题.
      return { ready, text: formatStatus(current, requireAgent(exec).id) }
    },
  })

  const tabs = defineTool({
    name: 'browser_tabs',
    description:
      '列出浏览器里的所有标签页 (id / 标题 / 地址 / 哪个在前台 / 哪个已被绑定). '
      + '页面操作只作用于被绑定的那个标签页, 所以操作前先用它看清有哪些标签, 再用 browser_select_tab 选一个.',
    parameters: {},
    presentCall: () => ({ card: 'generic', title: '列出标签页' }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true, description: '标签页数量' },
          boundTabId: { type: 'string', required: true, description: '当前绑定的标签页 id, 未绑定时为空字符串' },
          text: { type: 'string', required: true, description: '标签页清单' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (_args, exec) => runBrowser(deps, exec, async (resource) => {
      const list = await resource.call('tabs.list', {}, exec.signal)
      const bound = deps.runtime.boundTabId
      return {
        count: list.length,
        boundTabId: bound === null ? '' : String(bound),
        text: formatTabs(list, bound),
      }
    }),
  })

  const selectTab = defineTool({
    name: 'browser_select_tab',
    description:
      '把一个标签页设为操作目标并切到前台. 之后所有页面工具都作用于它. '
      + '这是唯一建立目标的途径: 插件刻意不做"跟随用户当前标签"这种隐式行为, 免得用户在别的标签页上看东西时被意外改动.',
    parameters: {
      tabId: {
        type: 'integer',
        required: true,
        description: '目标标签页 id, 由 browser_tabs 给出.',
      },
    },
    presentCall: (args) => ({ card: 'generic', title: `绑定标签页 id=${String(args.tabId)}` }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true, description: '已绑定的标签页 id' },
          url: { type: 'string', required: true, description: '该标签页地址' },
          title: { type: 'string', required: true, description: '该标签页标题' },
          text: { type: 'string', required: true, description: '给模型的摘要' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const tab = await resource.call('tabs.activate', { tabId: args.tabId }, exec.signal)
      return {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        text: `已绑定标签页 id=${String(tab.id)}: ${tab.title}\n${tab.url}\n下一步用 browser_snapshot 取页面结构.`,
      }
    }),
  })

  const closeTab = defineTool({
    name: 'browser_close_tab',
    description:
      '关闭一个标签页. 用 browser_tabs 拿到的 id 指定目标. '
      + '关掉的若是当前绑定标签页, 绑定会被自动清除 (后续页面操作会提示先重新绑定), '
      + '所以清理完一个任务后关闭它的标签页是安全的. '
      + '目标是所在窗口的最后一个标签页时会被拒绝: 那实际上等于关闭窗口, 甚至退出 Chrome 并断开整条链路; '
      + '需要清空时先开一个新标签页. '
      + '不要用它关掉 user 正在用的标签页, 除非 user 明确要求.',
    parameters: {
      tabId: { type: 'integer', required: true, description: '要关闭的标签页 id, 来自 browser_tabs' },
    },
    presentCall: (args) => ({ card: 'generic', title: `关闭标签页 #${String(args.tabId)}` }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true, description: '是否真的关闭了' },
          text: { type: 'string', required: true, description: '执行说明' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const wasBound = deps.runtime.boundTabId === args.tabId
      await resource.call('tabs.close', { tabId: args.tabId }, exec.signal)
      return {
        closed: true,
        text: `已关闭标签页 #${String(args.tabId)}.`
          // 绑定被清掉是调用方必须知道的状态变化, 否则下一步会莫名其妙地失败.
          + (wasBound ? '它原本是绑定标签页, 绑定已清除; 继续操作页面请先用 browser_select_tab 重新指定.' : ''),
      }
    }),
  })

  const release = defineTool({
    name: 'browser_release',
    description:
      '把浏览器驱动权交出去. 浏览器同一时刻只服务一个会话, 所以当别的会话要用时, 你可以用本工具'
      + '主动让出, 而不必等自己的会话结束. 让出之后本会话若还要用, 下一次浏览器调用会重新弹审批. '
      + '用完浏览器时主动让出是好习惯: 另一个会话的申请就不必等本会话被切走或结束. '
      + '本工具不需要审批, 因为它只是放弃, 不取得任何东西.',
    parameters: {},
    presentCall: () => ({ card: 'generic', title: '交还浏览器驱动权' }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          released: { type: 'boolean', required: true, description: '这次调用是否真的交出了驱动权' },
          text: { type: 'string', required: true, description: '执行说明' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (_args, exec) => {
      const agent = requireAgent(exec)
      const released = deps.runtime.release(agent)
      return {
        released,
        text: released
          ? '已交出浏览器驱动权; 别的会话现在可以申请使用. 本会话若还要用, 下一次浏览器调用会重新弹审批.'
          // 不是持有者时说清楚, 免得模型以为"释放过了"而重复调用.
          : (deps.runtime.grantedId === null
              ? '本会话没有持有浏览器驱动权, 而且现在也没有别的会话持有; 无需释放.'
              : `本会话没有持有浏览器驱动权, 它现在归会话 ${deps.runtime.grantedId} 使用; 无需释放.`),
      }
    },
  })

  return [open, status, tabs, selectTab, closeTab, release]
}
