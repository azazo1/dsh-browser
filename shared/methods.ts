/**
 * 扩展支持的方法清单及其参数与返回类型.
 *
 * 这些名字是宿主与扩展之间的私有约定, 不是模型可见的工具名. 模型看到的工具名
 * 在 src/tools/ 里定义, 由工具层翻译成这里的方法调用.
 */

import type { SnapshotResult, TabInfo } from './protocol.js'

/** 扩展侧支持的全部方法名. */
export type BrowserMethod =
  | 'tabs.list'
  | 'tabs.activate'
  | 'tabs.open'
  | 'tabs.close'
  | 'page.snapshot'
  | 'page.navigate'
  | 'page.click'
  | 'page.fill'
  | 'page.pressKey'
  | 'page.scroll'
  | 'page.text'
  | 'page.waitFor'
  | 'page.query'
  | 'page.hover'
  | 'page.uploadBegin'
  | 'page.uploadChunk'
  | 'page.uploadCommit'
  | 'page.uploadAbort'
  | 'page.screenshot'
  | 'page.evaluate'
  | 'console.start'
  | 'console.read'
  | 'console.stop'

/** 方法名到 参数/返回 的映射, 供两侧共用做类型约束. */
export interface MethodContract {
  'tabs.list': { args: Record<string, never>, result: TabInfo[] }
  'tabs.activate': { args: { tabId: number }, result: TabInfo }
  'tabs.open': { args: { url: string }, result: TabInfo }
  'tabs.close': { args: { tabId: number }, result: { closed: true } }
  'page.snapshot': { args: Record<string, never>, result: SnapshotResult }
  'page.navigate': { args: { url: string }, result: { url: string, title: string } }
  'page.click': { args: { token: string, index: number }, result: PageActionResult }
  'page.fill': { args: { token: string, index: number, text: string, submit?: boolean }, result: PageActionResult }
  'page.pressKey': { args: { key: string }, result: PageActionResult }
  'page.scroll': { args: { direction: 'up' | 'down', amount?: number }, result: PageActionResult }
  'page.text': { args: Record<string, never>, result: { url: string, title: string, text: string, truncated: boolean } }
  'page.waitFor': { args: { text: string, timeoutMs?: number }, result: { found: boolean, note: string } }
  'page.query': { args: { selector: string, limit?: number, maxChars?: number }, result: QueryResult }
  'page.hover': { args: { token: string, index: number }, result: PageActionResult }
  'page.uploadBegin': { args: UploadBeginArgs, result: { uploadId: string, note: string } }
  'page.uploadChunk': { args: { uploadId: string, data: string }, result: { received: number, note: string } }
  'page.uploadCommit': { args: { selector: string, nth: number, uploadIds: string[] }, result: UploadResult }
  'page.uploadAbort': { args: { uploadIds: string[] }, result: { aborted: number, note: string } }
  'page.screenshot': { args: { format?: 'png' | 'jpeg' }, result: ScreenshotResult }
  'page.evaluate': { args: { expression: string, world?: EvaluateWorld }, result: EvaluateResult }
  'console.start': { args: Record<string, never>, result: { tabId: number, note: string } }
  'console.read': { args: { waitMs?: number }, result: ConsoleReadResult }
  'console.stop': { args: Record<string, never>, result: ConsoleReadResult }
}

/** 一次结构化取值的结果. */
export interface QueryResult {
  url: string
  title: string
  /** 页面中匹配到的总数, 可能大于 items.length. */
  total: number
  /** 是否因 limit 或单条长度上限而截断. */
  truncated: boolean
  items: QueryItem[]
}

/** 一条匹配项. */
export interface QueryItem {
  /** 在匹配结果里的序号, 从 0 开始. */
  index: number
  /** 小写标签名. */
  tag: string
  /** 元素文本, 已压缩空白并截断. */
  text: string
  /** 元素的属性表; 值已截断. */
  attributes: Record<string, string>
}

/**
 * 开始上传一个文件.
 *
 * 目标用选择器而不是快照编号, 因为文件输入框几乎总是被藏起来 (需要点按钮才触发), 而
 * 快照只收可见元素, 用编号根本找不到它.
 */

export interface UploadBeginArgs {
  /** 文件名, 只用于展示与页面的 File.name. */
  name: string
  /** MIME 类型. */
  mime: string
  /** 文件总字节数, 用于校验分块是否收全. */
  bytes: number
}

/** 上传完成后的结果. */
export interface UploadResult {
  /** 页面最终收到的 File 描述, 每个文件一条. */
  files: { name: string, bytes: number, mime: string }[]
  note: string
}

/**
 * 一次截图的字节.
 *
 * 这里返回的是 **base64 而不是 data URL**: data URL 前缀只是搬运格式, 让扩展拼出来再
 * 让宿主剥掉纯属多余, 而多一层字符串处理就多一处出错的地方.
 */
export interface ScreenshotResult {
  /** PNG 或 JPEG 的 base64 内容, 不含 data URL 前缀. */
  data: string
  /** 实际编码格式. */
  format: 'png' | 'jpeg'
  /** 截取时的像素宽高, 来自页面视口与设备像素比. */
  width: number
  height: number
  /** 截图的页面地址, 便于确认截到的确实是目标页. */
  url: string
}

/**
 * 求值所在的 JavaScript 世界.
 *
 * `isolated` 是扩展自己的世界, 看不到页面自己的 JS 变量, 但不受页面 CSP 影响.
 * `main` 是页面本身的世界, 能看到页面的 JS 变量, 但页面 CSP 会约束里面动态加载的代码.
 */
export type EvaluateWorld = 'isolated' | 'main'

/** 一次求值的结果. */
export interface EvaluateResult {
  /**
   * 结果的 JSON 文本, 而不是结构化值.
   *
   * 页面里的值可能是函数, DOM 节点, 循环引用, bigint —— 这些都无法直接跨进程序列化.
   * 所以序列化在页面里完成, 结果统一收敛成一个字符串, 宿主不必再猜它能不能过 JSON 边界.
   */
  value: string
  /** 结果是否因深度或长度上限被截断. */
  truncated: boolean
  /** 结果值的类型说明, 例如 "object" / "string"; 序列化后类型信息会丢失, 所以单独给出. */
  valueType: string
}

/**
 * 一次页面操作的结果; 操作完成不代表结果符合预期, 需要重新快照确认.
 *
 * 这里**没有 `ok` 字段**, 是有意的: 失败在扩展侧就抛成错误帧 (见 injected.ts 里那个
 * 判别联合, 由 page.ts 的 unwrap 转成抛出), 所以能走到"返回一个结果"这一步就意味着
 * 成功. 曾经这里声明过 `ok: true` 而扩展实现没返回它, 结果四个操作工具的产物里多出
 * 一个 `undefined`, 被 harness 的 lossless-JSON 检查全数拒掉 —— 而类型系统看不出这层
 * 不一致, 因为两侧由这份声明连接, 实现压根不受它约束. 少一个冗余字段就少一处能漂移
 * 的地方.
 */
export interface PageActionResult {
  /** 补充说明, 例如点击命中了什么元素. */
  note: string
}

/**
 * 一条 console 输出.
 *
 * level 是归一化后的级别, 直接来自 CDP 的 console API type; `dir` / `table` / `trace`
 * 这类"更像是展示命令"的调用归入 `other`, 原始 type 单独保留在 type 字段里, 宿主不必
 * 猜一条 `other` 到底是什么.
 */
export interface ConsoleEntry {
  /** 会话内单调递增的序号; read 以它推进水位线, 宿主以它保证顺序. */
  seq: number
  level: 'log' | 'info' | 'warning' | 'error' | 'debug' | 'other'
  /** CDP 的原始 console API type, 例如 log / dir / table / startGroup. */
  type: string
  /** 全部参数格式化后的文本; 单条有长度上限, 超长会截断. */
  text: string
  /** 输出来源脚本; 页面内联执行或异常没有位置时为 null. */
  url: string | null
  /** 来源行号与列号; 与 url 配套, 无位置时为 null. */
  line: number | null
  /** 事件的时间戳 (epoch 毫秒, 来自 CDP). */
  timestamp: number
}

/** 一次 console 读取 (或停止) 的结果. */
export interface ConsoleReadResult {
  /** 自上次读取以来的条目, 按 seq 升序; 读取会推进水位线 (stop 是最终一次). */
  entries: ConsoleEntry[]
  /** 读取时抓取是否仍在进行; stop 之后恒为 false. */
  capturing: boolean
  /**
   * 抓取被中断的原因; null 表示没有中断过.
   *
   * 用户点掉"已开始调试此浏览器"提示条, 打开 DevTools, 标签页关闭, 以及 service worker
   * 重启后 attachment 丢失, 都会走到这里 —— 缓冲里的条目仍然可读, 但之后不会再有新的.
   */
  interrupted: string | null
  /** 给模型的说明, 包含条数与下一步建议. */
  note: string
}

/** 取某个方法的参数类型. */
export type MethodArgs<M extends BrowserMethod> = MethodContract[M]['args']

/** 取某个方法的返回类型. */
export type MethodResult<M extends BrowserMethod> = MethodContract[M]['result']

/** 运行时校验用的方法名清单. */
export const BROWSER_METHODS: readonly BrowserMethod[] = [
  'tabs.list',
  'tabs.activate',
  'tabs.open',
  'tabs.close',
  'page.snapshot',
  'page.navigate',
  'page.click',
  'page.fill',
  'page.pressKey',
  'page.scroll',
  'page.text',
  'page.waitFor',
  'page.query',
  'page.hover',
  'page.uploadBegin',
  'page.uploadChunk',
  'page.uploadCommit',
  'page.uploadAbort',
  'page.screenshot',
  'page.evaluate',
  'console.start',
  'console.read',
  'console.stop',
]

/** 判断一个字符串是否是已知方法名. */
export function isBrowserMethod(value: string): value is BrowserMethod {
  return (BROWSER_METHODS as readonly string[]).includes(value)
}
