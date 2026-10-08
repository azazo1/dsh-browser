/**
 * 页面级工具: 读取页面结构, 以及按编号操作页面.
 *
 * 交互模型是"带编号的文本清单": browser_snapshot 把页面转成元素编号表, 后续的点击
 * 与填入用编号寻址. 这样做的好处是不需要截图也不需要视觉模型, 而且编号和正文都来自
 * 同一次采集, 不会出现"看到的是这一版, 操作的是那一版"的错位 —— 快照编号 (token)
 * 就是用来发现这种错位的.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { formatSnapshot, runBrowser, toIntegerArg } from './shared.js'
import type { ToolDeps } from './shared.js'

/** 页面工具共用的"结果说明"输出形状. */
const ACTION_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '这一步是否执行成功' },
    text: { type: 'string', required: true, description: '执行说明' },
  },
} as const

/**
 * 构造页面级工具集.
 * @param deps 工具依赖.
 * @returns 待注册的工具定义.
 */
export function pageTools(deps: ToolDeps): ToolDefinition[] {
  const snapshot = defineTool({
    name: 'browser_snapshot',
    description:
      '取当前绑定标签页的结构: 先列出可交互元素的编号清单 (按钮/链接/输入框等, 带角色与名称), '
      + '再给出页面正文文本. 返回的"快照编号"是后续点击与填入必须携带的凭据, '
      + '页面一旦变化它就会失效, 此时重新调用本工具即可. '
      + '页面操作的第一步永远是本工具; 操作之后也应当再取一次, 确认结果是否符合预期.',
    parameters: {},
    presentCall: () => ({ card: 'generic', title: '获取页面快照' }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true, description: '页面地址' },
          title: { type: 'string', required: true, description: '页面标题' },
          token: { type: 'string', required: true, description: '快照编号, 点击与填入时回传' },
          elementCount: { type: 'integer', required: true, description: '可交互元素数量' },
          text: { type: 'string', required: true, description: '给模型的完整快照文本' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (_args, exec) => runBrowser(deps, exec, async (resource) => {
      const result = await resource.call('page.snapshot', {}, exec.signal)
      return {
        url: result.url,
        title: result.title,
        token: result.token,
        elementCount: result.elements.length,
        text: formatSnapshot(result),
      }
    }),
  })

  const text = defineTool({
    name: 'browser_text',
    description:
      '只取当前绑定标签页的正文文本, 不带元素编号清单. 需要通读长文或做摘要时用它更省篇幅; '
      + '需要点击时用 browser_snapshot.',
    parameters: {},
    presentCall: () => ({ card: 'generic', title: '读取页面正文' }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true, description: '页面地址' },
          title: { type: 'string', required: true, description: '页面标题' },
          truncated: { type: 'boolean', required: true, description: '文本是否被截断' },
          text: { type: 'string', required: true, description: '页面正文, 前置一行标题与地址' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (_args, exec) => runBrowser(deps, exec, async (resource) => {
      const result = await resource.call('page.text', {}, exec.signal)
      const header = `标题: ${result.title}\n地址: ${result.url}${result.truncated ? '\n(文本已截断)' : ''}\n\n`
      return { url: result.url, title: result.title, truncated: result.truncated, text: header + result.text }
    }),
  })

  const click = defineTool({
    name: 'browser_click',
    description:
      '点击当前页面快照里的一个元素. 必须带上最近一次 browser_snapshot 返回的快照编号; '
      + '编号过期时会明确报错, 而不是点到一个已经变了的元素上. '
      + '点击会滚动到该元素并派发完整的指针事件序列 (pointerdown/mousedown/pointerup/mouseup/click), '
      + '所以依赖 pointerdown 的前端框架也能收到.',
    parameters: {
      token: { type: 'string', required: true, description: 'browser_snapshot 返回的快照编号' },
      index: { type: 'integer', required: true, description: '要点击的元素编号' },
    },
    presentCall: (args) => ({ card: 'generic', title: `点击元素 #${String(args.index)}` }),
    output: { schema: ACTION_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const result = await resource.call('page.click', { token: args.token, index: args.index }, exec.signal)
      return { ok: result.ok, text: `${result.note}\n点击完成不代表结果符合预期, 请用 browser_snapshot 确认页面变化.` }
    }),
  })

  const fill = defineTool({
    name: 'browser_fill',
    description:
      '向当前页面快照里的一个输入框或可编辑区域填入文本. 需要快照编号与元素编号. '
      + '填入会走元素原型上的 value setter 并派发 input/change 事件, 因此 React 一类受控组件也能识别. '
      + 'submit 为 true 时会在填入后发送 Enter 键 (用于触发搜索框、聊天输入框等). '
      + '注意: 文件上传框不能用文本填入, 那种操作需要用户手动完成.',
    parameters: {
      token: { type: 'string', required: true, description: 'browser_snapshot 返回的快照编号' },
      index: { type: 'integer', required: true, description: '目标输入元素的编号' },
      text: { type: 'string', required: true, description: '要填入的完整文本 (会替换原有内容)' },
      submit: { type: 'boolean', description: '填入后是否发送 Enter. 省略为否.' },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `填入元素 #${String(args.index)}`,
      rawInput: { index: args.index, chars: args.text.length, submit: args.submit === true },
    }),
    output: { schema: ACTION_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const result = await resource.call('page.fill', {
        token: args.token,
        index: args.index,
        text: args.text,
        submit: args.submit === true,
      }, exec.signal)
      return { ok: result.ok, text: `${result.note}\n请用 browser_snapshot 确认填入与提交的实际效果.` }
    }),
  })

  const pressKey = defineTool({
    name: 'browser_press_key',
    description:
      '向当前页面发送一次按键. 目标优先取页面里当前的焦点元素, 没有焦点时发给 body, '
      + '因此也适用于全局快捷键. 常用值: Enter, Escape, Tab, ArrowDown, ArrowUp, PageDown, PageUp, Home, End. '
      + '单字符键 (例如 a) 也可以直接传.',
    parameters: {
      key: { type: 'string', required: true, description: '按键名, 例如 Enter / Escape / Tab / ArrowDown' },
    },
    presentCall: (args) => ({ card: 'generic', title: `发送按键 ${args.key}` }),
    output: { schema: ACTION_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const result = await resource.call('page.pressKey', { key: args.key }, exec.signal)
      return { ok: result.ok, text: result.note }
    }),
  })

  const scroll = defineTool({
    name: 'browser_scroll',
    description:
      '滚动当前页面. 返回里会给出滚动前后的位置与可达范围, 因此能直接判断是否已经到顶或到底, '
      + '不需要反复试探. 长页面里"滚到某处再取快照"比一次性读完更省上下文.',
    parameters: {
      direction: { type: 'string', required: true, enum: ['up', 'down'], description: '滚动方向' },
      amount: { type: 'integer', description: '滚动像素数; 省略时滚动约一屏.' },
    },
    presentCall: (args) => ({ card: 'generic', title: `向${args.direction === 'up' ? '上' : '下'}滚动` }),
    output: { schema: ACTION_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const result = await resource.call('page.scroll', {
        direction: args.direction,
        ...(args.amount === undefined ? {} : { amount: toIntegerArg(args.amount, 'amount', 0) }),
      }, exec.signal)
      return { ok: result.ok, text: result.note }
    }),
  })

  const navigate = defineTool({
    name: 'browser_navigate',
    description:
      '让当前绑定的标签页跳到一个新地址, 并等待加载完成. '
      + '注意: Chrome 内部页面 (chrome:// 等) 以及扩展商店页面禁止脚本注入, 这类地址会被直接拒绝. '
      + '导航完成后请用 browser_snapshot 取新页面结构.',
    parameters: {
      url: { type: 'string', required: true, description: '目标地址, 例如 https://example.com' },
    },
    presentCall: (args) => ({ card: 'generic', title: `导航到 ${args.url}`, rawInput: { url: args.url } }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '导航是否被接受' },
          url: { type: 'string', required: true, description: '导航后的实际地址' },
          text: { type: 'string', required: true, description: '执行说明' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const result = await resource.call('page.navigate', { url: args.url }, exec.signal)
      return {
        ok: true,
        url: result.url,
        text: `已导航到 ${result.url}\n标题: ${result.title}\n请用 browser_snapshot 取新页面结构.`,
      }
    }),
  })

  const wait = defineTool({
    name: 'browser_wait',
    description:
      '等待当前页面出现指定文本 (在前台轮询, 不会挂住页面). 用于等异步加载或提交后的跳转. '
      + '返回里会说明是否找到, 以及超时时停在哪个地址与标题, 便于判断是没加载完还是页面本就不同. '
      + '只在 iframe 内部出现的文本不会被找到.',
    parameters: {
      text: { type: 'string', required: true, description: '要等待出现的文本片段' },
      timeoutMs: { type: 'integer', description: '等待上限, 默认 10000 毫秒.' },
    },
    presentCall: (args) => ({ card: 'generic', title: `等待文本 "${args.text}"` }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true, description: '在超时前是否出现' },
          text: { type: 'string', required: true, description: '执行说明' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const timeoutMs = toIntegerArg(args.timeoutMs, 'timeoutMs', 10_000)
      const result = await resource.call('page.waitFor', { text: args.text, timeoutMs }, exec.signal)
      return {
        found: result.found,
        text: result.found
          ? result.note
          : `${result.note}\n如果页面确实应该有这段文本, 可能是内容在 iframe 内, 或需要先滚动触发加载.`,
      }
    }),
  })

  return [snapshot, text, click, fill, pressKey, scroll, navigate, wait]
}
