/**
 * 进阶工具: 结构化取值, 悬停, 文件上传, 浏览器内求值.
 *
 * 与 `page.ts` 的分工: 那边是"看页面"和"点页面"的基础工具 (快照 / 正文 / 点击 / 填入 /
 * 按键 / 滚动 / 导航), 做的都是页面表层的事; 这里的四个各自需要额外的东西 —— 取值与求值
 * 是拿数据而不是操作页面, 悬停要多派发一套移入事件, 上传要跨多条消息搬文件. 按能力而不
 * 是按文件长度分开, 免得 page.ts 变成什么都往里塞的筐.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { formatQuery, formatValue } from './format.js'
import { runBrowser } from './shared.js'
import type { ToolDeps } from './shared.js'

/**
 * 宿主发往扩展的单条消息能装多少字节.
 *
 * Chrome 限制 native messaging 从宿主发往扩展的单条消息不超过 1 MB. 取 512 KiB 是因为
 * base64 会膨胀约 4/3, 512 KiB 原文编码后约 683 KiB, 留出余量给帧头与 JSON 包装.
 */
const UPLOAD_CHUNK_BYTES = 512 * 1024

/**
 * 单次上传允许的最大文件.
 *
 * 不是技术硬上限, 而是防护: 上传要把整个文件读进内存并逐块编码, 24 MiB 已经超过绝大多数
 * 表单场景, 再大更可能是误用而不是真实需求.
 */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024

/** 按扩展名猜 MIME; 猜不出时退回通用二进制类型, 由页面自己识别. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/**
 * 按路径猜 MIME.
 * @param path 文件路径.
 * @returns MIME 类型.
 */
function guessMimeType(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 把字节编成 base64.
 *
 * 逐字节拼字符串而不是 `String.fromCharCode(...bytes)`: 后者在文件稍大时会超出引擎的
 * 参数个数上限而抛栈溢出, 而且这个上限因引擎而异, 属于不该依赖的东西.
 *
 * @param bytes 字节.
 * @returns base64 文本.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 8_192
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return Buffer.from(binary, 'binary').toString('base64')
}

/**
 * 构建进阶工具集.
 *
 * @param deps 工具依赖.
 * @returns 工具定义清单.
 */
export function advancedTools(deps: ToolDeps): ToolDefinition[] {
  const query = defineTool({
    name: 'browser_query',
    description:
      '用 CSS 选择器从页面批量取结构化数据 (文本与属性), 用于读表格, 列表, 链接, '
      + 'JSON-LD 等场合. 它比 browser_snapshot 更适合取数据: snapshot 只列可见的可交互元素 '
      + '并给编号, 供操作使用; 本工具返回**全部**匹配项 (含隐藏元素) 的文本与属性. '
      + '需要页面里的 JS 变量或做计算时用 browser_evaluate.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS 选择器, 例如 "table tr" 或 "a[href]"' },
      limit: { type: 'integer', description: '最多返回多少条, 默认 50, 上限 500' },
      max_chars: { type: 'integer', description: '每条文本与属性值的字符上限, 默认 200' },
    },
    presentCall: (args) => ({ card: 'generic', title: `按选择器取值 ${args.selector}` }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true, description: '页面地址' },
          title: { type: 'string', required: true, description: '页面标题' },
          total: { type: 'integer', required: true, description: '页面中匹配到的总数' },
          truncated: { type: 'boolean', required: true, description: '是否被上限截断' },
          text: { type: 'string', required: true, description: '给模型的取值结果文本' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 500)
      const maxChars = Math.min(Math.max(args.max_chars ?? 200, 20), 4_000)
      const result = await resource.call('page.query', { selector: args.selector, limit, maxChars }, exec.signal)
      return {
        url: result.url,
        title: result.title,
        total: result.total,
        truncated: result.truncated,
        text: formatQuery(result),
      }
    }),
  })

  const hover = defineTool({
    name: 'browser_hover',
    description:
      '把鼠标悬停到快照里的一个元素上. 下拉菜单, 悬浮提示, 以及"某些按钮只在悬停后出现"'
      + '这类界面只认鼠标移入, 单靠 browser_click 到不了. '
      + '悬停后请用 browser_snapshot 确认是否出现了新元素, 再点其中的项.',
    parameters: {
      token: { type: 'string', required: true, description: 'browser_snapshot 返回的快照编号' },
      index: { type: 'integer', required: true, description: '要悬停到的元素编号' },
    },
    presentCall: (args) => ({ card: 'generic', title: `悬停到元素 #${String(args.index)}` }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: '执行说明' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const result = await resource.call('page.hover', { token: args.token, index: args.index }, exec.signal)
      return { text: result.note }
    }),
  })

  const upload = defineTool({
    name: 'browser_upload',
    description:
      '把本机文件装进页面的文件输入框. 常见形态是页面上有个"选择文件"按钮, 真正的 '
      + 'input[type=file] 被隐藏起来, 所以这个工具按**选择器**定位输入框, 而不是按快照编号 '
      + '(隐藏元素不在快照的编号表里). 默认找页面上的第一个 input[type=file]; '
      + '有多个时用 selector 与 nth 指定. 装好之后若表单还需要提交, 请再点提交按钮. '
      + '文件大小上限 24 MiB.',
    parameters: {
      file_paths: {
        type: 'array',
        required: true,
        description: '要上传的本机文件路径; 多文件时按顺序装进输入框',
        items: { type: 'string' },
      },
      selector: { type: 'string', description: '文件输入框的选择器, 默认 "input[type=file]"' },
      nth: { type: 'integer', description: '匹配到多个输入框时用第几个, 从 0 开始, 默认 0' },
    },
    presentCall: (args) => ({ card: 'generic', title: `上传 ${String(args.file_paths.length)} 个文件` }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true, description: '装入的文件数' },
          text: { type: 'string', required: true, description: '执行说明' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const selector = args.selector ?? 'input[type=file]'
      const nth = Math.max(args.nth ?? 0, 0)

      // 先把每个文件读齐再开始上传: 中途才发现某个文件读不了会留下半套已装进页面的内容,
      // 而页面侧的暂存区已经被写过, 状态就说不清了.
      const prepared: { name: string, mime: string, bytes: Uint8Array }[] = []
      for (const path of args.file_paths) {
        let info
        try {
          info = await stat(path)
        } catch (error) {
          throw new Error(`读不到文件 ${path}: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!info.isFile()) throw new Error(`${path} 不是普通文件`)
        if (info.size > MAX_UPLOAD_BYTES) {
          throw new Error(
            `${path} 有 ${String(info.size)} 字节, 超过单次上传上限 ${String(MAX_UPLOAD_BYTES)} 字节; `
            + '请改用更小的文件',
          )
        }
        prepared.push({ name: basename(path), mime: guessMimeType(path), bytes: await readFile(path) })
      }

      const uploadIds: string[] = []
      try {
        for (const file of prepared) {
          const begun = await resource.call(
            'page.uploadBegin',
            { name: file.name, mime: file.mime, bytes: file.bytes.length },
            exec.signal,
          )
          uploadIds.push(begun.uploadId)
          for (let offset = 0; offset < file.bytes.length; offset += UPLOAD_CHUNK_BYTES) {
            const slice = file.bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, file.bytes.length))
            await resource.call(
              'page.uploadChunk',
              { uploadId: begun.uploadId, data: toBase64(slice) },
              exec.signal,
            )
          }
        }
        const committed = await resource.call(
          'page.uploadCommit',
          { selector, nth, uploadIds },
          exec.signal,
        )
        return { count: committed.files.length, text: committed.note }
      } catch (error) {
        // 失败时把页面侧的暂存清掉, 免得半个文件占着内存并且影响下一次上传.
        if (uploadIds.length > 0) {
          await resource.call('page.uploadAbort', { uploadIds }, exec.signal).catch(() => undefined)
        }
        throw error
      }
    }),
  })

  const evaluate = defineTool({
    name: 'browser_evaluate',
    description:
      '在页面里执行一个 JavaScript **表达式**并取回结果. 适合取页面 JS 变量, 做计算, '
      + '或提取选择器表达不了的结构. 表达式支持 await; 需要对象字面量时请用括号包起来 '
      + '(例如 "({a: 1})"), 也可以用立即执行的箭头函数写多步逻辑 (例如 "(() => { ... })()"). '
      + '结果会做深度, 长度与循环引用处理, 无法序列化的值 (函数, DOM 节点, bigint) 会被转成 '
      + '可读的字符串说明. '
      + '默认在扩展自己的世界里执行, 那里看不到页面自己的 JS 变量; 需要读页面变量时传 '
      + 'world: "main". '
      + '本工具需要用户在扩展详情页打开 "Allow User Scripts" 开关, 没打开时会明确提示, '
      + '此时可改用 browser_query 取数据.',
    parameters: {
      expression: { type: 'string', required: true, description: '要执行的 JavaScript 表达式' },
      world: {
        type: 'string',
        description: '执行世界: "isolated" (默认, 看不到页面 JS 变量) 或 "main" (能看到, 但受页面 CSP 约束)',
      },
    },
    presentCall: () => ({ card: 'generic', title: '在页面里求值' }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string', required: true, description: '求值结果的 JSON 文本' },
          valueType: { type: 'string', required: true, description: '结果值的类型' },
          truncated: { type: 'boolean', required: true, description: '结果是否被截断' },
          text: { type: 'string', required: true, description: '给模型的完整文本' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const world = args.world === 'main' ? 'main' : 'isolated'
      const result = await resource.call(
        'page.evaluate',
        { expression: args.expression, world },
        exec.signal,
        // 求值可能触发页面的异步逻辑, 给一个比默认更宽松的上限.
        { timeoutMs: 30_000 },
      )
      return {
        value: result.value,
        valueType: result.valueType,
        truncated: result.truncated,
        text: formatValue(result, args.expression, world),
      }
    }),
  })

  return [query, hover, upload, evaluate]
}
