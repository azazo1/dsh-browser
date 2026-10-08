/**
 * dsh-browser 线协议.
 *
 * 这份文件被两侧同时引用, 是唯一的协议真源:
 *   - 扩展侧 (extension/src/**): 在浏览器里执行操作.
 *   - 宿主侧 (src/**): 把 Agent 的工具调用翻译成这里的 call.
 *
 * 两段链路:
 *   宿主 <-> NM host   走 WebSocket (回环地址, 路径 /ext/bridge, 需要 token)
 *   NM host <-> 扩展   走 Chrome native messaging (stdio, 4 字节小端长度前缀 + JSON)
 *
 * NM host 只做搬运, 不解析业务语义, 所以两段用同一套 JSON 帧.
 */

import type { BrowserMethod } from './methods.js'

/** 协议版本; 两侧不一致时直接拒绝, 避免半懂不懂地跑. */
export const PROTOCOL_VERSION = 1

/**
 * native messaging 清单名.
 *
 * 这个名字同时决定三件事, 改动等于不兼容变更:
 *   - Chrome 查找清单文件的文件名.
 *   - 扩展调用 `chrome.runtime.connectNative(<name>)` 的参数.
 *   - 清单里 `allowed_origins` 必须精确匹配本扩展 ID.
 */
export const NATIVE_HOST_NAME = 'com.azazo1.dsh_browser'

/** 宿主 WebSocket 升级路由的路径. */
export const BRIDGE_PATH = '/ext/bridge'

/** 宿主与扩展协商的渲染宽度上限, 超过就截断, 防止把上下文撑爆. */
export const MAX_TEXT_CHARS = 120_000

/** 一次工具调用的默认截止时间; 扩展超时会回一个错误而不是一直挂着. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000

/**
 * console.read 长轮询的等待上限.
 *
 * 两侧共用: 扩展用它截住等待, 宿主用它计算调用超时 (waitMs + 余量). 放在协议层是因为
 * 它约束的是"read 这次调用能等多久"这个两侧都要遵守的行为, 不是某一侧的实现细节.
 */
export const MAX_CONSOLE_READ_WAIT_MS = 10_000

/** 页面快照里一个可交互元素的编号条目. */
export interface SnapshotElement {
  /** 快照内的稳定编号, 后续 click / fill 用它寻址. */
  index: number
  /** 元素角色, 例如 button / link / textbox. */
  role: string
  /** 无障碍名或可见文本, 已被截断. */
  name: string
  /** 补充说明, 例如输入框类型, 是否禁用, 是否勾选. */
  note?: string
}

/** 一次页面快照的结果. */
export interface SnapshotResult {
  url: string
  title: string
  /** 快照编号; 点击时带回, 避免用陈旧编号操作已变的页面. */
  token: string
  /** 页面主体文本. */
  text: string
  /** 可交互元素清单. */
  elements: SnapshotElement[]
  /** 文本或元素被截断时为 true. */
  truncated: boolean
}

/** 一个浏览器标签页的描述. */
export interface TabInfo {
  /** `chrome.tabs` 的标签页 id. */
  id: number
  url: string
  title: string
  active: boolean
  /** 该标签页是否属于本扩展可操作的窗口. */
  windowId: number
}

/** 扩展发给宿主的握手信息. */
export interface HelloPayload {
  protocolVersion: number
  extensionId: string
  /** 扩展清单版本. */
  version: string
  /** 扩展当前是否已绑定到一个标签页. */
  boundTabId: number | null
  /**
   * "Allow User Scripts" 开关是否已打开, 决定浏览器求值能不能用.
   *
   * 可选: 老版本扩展不会报这个字段, 缺失时按"未知"处理而不是"不支持".
   */
  userScripts?: boolean
  /**
   * 扩展自己生成并在界面上展示的配对令牌.
   *
   * 用户把它抄进 dsh 的插件配置, 握手时由 dsh 核对: 对不上就拒绝这条连接. 方向是"扩展
   * 向 dsh 证明自己", 因为令牌是在扩展侧生成并展示, 由人抄进 dsh 的.
   */
  pairingToken?: string
  /**
   * 拉起这条 native host 的 Chrome 的 `--user-data-dir`.
   *
   * 由 host 在转发 hello 时盖上, 扩展自己填不了. 独立 profile 开着时, 桥只接受
   * 与配置里那份目录一致的连接, 避免日常 Chrome 把独立窗口的通道顶掉.
   */
  userDataDir?: string | null
  /**
   * 扩展当前是否正通过 chrome.debugger 抓取 console.
   *
   * 可选: 老版本扩展不会报这个字段, 缺失时按"未在抓取"处理. 宿主与 popup 用它展示
   * "console 抓取进行中"的状态, 因为提示条之外用户在页面上看不到任何痕迹.
   */
  consoleCapturing?: { tabId: number } | null
}

/** 宿主发往扩展的调用帧. */
export interface CallFrame {
  kind: 'call'
  /** 单调递增的调用号, 用于配对响应. */
  id: number
  method: BrowserMethod
  args: unknown
  /** 扩展侧的截止时间; 超时后必须回错误, 不能继续挂着. */
  timeoutMs: number
}

/** 扩展对一次调用的成功响应. */
export interface ResultFrame {
  kind: 'result'
  id: number
  ok: true
  value: unknown
}

/** 扩展对一次调用的失败响应. */
export interface ErrorFrame {
  kind: 'error'
  id: number
  ok?: false
  error: {
    /** 机器可读的错误类别, 让工具层能给出可自我纠正的提示. */
    code: string
    message: string
  }
}

/** 扩展主动上报的事件, 不需要配对. */
/**
 * 扩展主动上报, 或 native host 上报自身链路状态的事件.
 *
 * `link-ready` / `link-lost` 由 native host 发出, 而不是扩展: 扩展自己的
 * `connectNative` 只证明"host 进程起来了", 并不证明 host 连上了 dsh. 这两个事件才
 * 是链路真实状态的唯一来源, 界面必须据此显示, 否则会出现"显示已连接但 dsh 里什么都
 * 没有"这种误导.
 *
 * `pairing-rejected` 由 dsh 侧发出并转给扩展: 配对令牌对不上时 dsh 会拒绝这条连接,
 * 扩展必须能把原因显示给用户, 否则用户只会看到"连不上"而不知道去填令牌.
 *
 * `bound` 由扩展在绑定标签页建立 (tabs.activate / tabs.open) 时发出: 宿主的绑定
 * 状态只从 hello 与事件里来, 绑定这个动作本身不触发 URL 变化, 不上报的话 browser_status
 * 会一直显示"绑定标签页: 无".
 */
export interface EventFrame {
  kind: 'event'
  event: 'hello' | 'tab-changed' | 'bound' | 'detached' | 'link-ready' | 'link-lost' | 'pairing-rejected'
  payload: unknown
}

/** 扩展发往宿主的所有帧. */
export type OutboundFrame = ResultFrame | ErrorFrame | EventFrame

/** 宿主发往扩展的所有帧. */
export type InboundFrame = CallFrame

/** 错误类别; 工具层据此生成可自我纠正的中文提示. */
export type ErrorCode =
  /** 页面或标签页已经不存在, 需要重新快照或重新打开. */
  | 'stale-target'
  /** 编号在最近一次快照里不存在. */
  | 'unknown-element'
  /** 目标标签页不在前台, 需要先激活. */
  | 'tab-not-active'
  /** 扩展尚未绑定标签页. */
  | 'no-binding'
  /** 注入脚本被该页面拒绝 (例如 chrome:// 或扩展页). */
  | 'injection-blocked'
  /** 扩展开关关闭了该操作. */
  | 'forbidden'
  /** 目标是所在窗口里最后一个标签页, 关掉它等于关闭窗口. */
  | 'last-tab'
  /** 配对令牌不匹配, 连接已被拒绝. */
  | 'pairing-rejected'
  /** 超时. */
  | 'timeout'
  /** 其余未分类失败. */
  | 'internal'
