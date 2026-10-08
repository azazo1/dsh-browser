/**
 * 在页面里求值.
 *
 * 走 `chrome.userScripts` 而不是 `chrome.scripting`:
 *
 *   - `chrome.scripting.executeScript` 只接受**函数** (字符串代码在 MV3 被禁), 而求值必须
 *     把模型给的表达式当代码执行, 所以它做不到;
 *   - 扩展自己页面与 ISOLATED world 的 CSP 是 `script-src 'self'`, 官方明确不允许追加
 *     `'unsafe-eval'`, 于是 `new Function` 在那两个环境里同样被挡;
 *   - `chrome.userScripts` 的 `USER_SCRIPT` world 明确**豁免页面 CSP**, 并且它的执行入口
 *     本来就接受代码字符串, 所以它是这个需求唯一稳的路.
 *
 * 代价是它需要额外的 `userScripts` 权限, 而且用户必须在扩展详情页手动打开 "Allow User
 * Scripts" 开关 (Chrome 138+; 更早的版本是开发者模式). 开关没开时 `chrome.userScripts`
 * 是 undefined, 所以这里把这种情况单独识别出来, 给出能直接照做的指引, 而不是抛一句通用
 * 报错让人猜.
 *
 * 结果一律收敛成**字符串**: 页面里的值可能是函数, DOM 节点, 循环引用, bigint, 这些都无法
 * 直接跨进程序列化, 所以序列化在页面侧完成, 宿主只拿到一个字符串, 不必再赌它能不能过
 * JSON 边界.
 */

import { PageError } from './page.js'
import type { EvaluateResult, EvaluateWorld } from '../../../shared/methods.js'

/**
 * `chrome.userScripts` 的最小接口.
 *
 * @types/chrome 0.0.254 还没有这个命名空间, 而我们只用到一个方法, 所以在这里按官方
 * 文档的形状自行声明, 不去改第三方类型.
 */
interface UserScriptsApi {
  execute(injection: {
    target: { tabId: number }
    js: { code: string }[]
    world?: 'USER_SCRIPT' | 'MAIN'
  }): Promise<UserScriptsInjectionResult[]>
}

/** 单条注入结果. */
interface UserScriptsInjectionResult {
  documentId?: string
  /** 出错时是错误文本; 与 result 互斥. */
  error?: string
  frameId?: number
  result?: unknown
}

/**
 * 取可用的 userScripts 接口.
 *
 * 开关没打开时 `chrome.userScripts` 是 undefined. 读它本身也可能抛错 (权限被中途收回时
 * Chrome 会这样), 所以整个访问都包在 try 里.
 *
 * @returns 接口, 或 null 表示当前不可用.
 */
function userScriptsApi(): UserScriptsApi | null {
  try {
    const chromeLike = chrome as unknown as { userScripts?: UserScriptsApi }
    return chromeLike.userScripts ?? null
  } catch {
    return null
  }
}

/** Chrome 的开关指引. */
const TOGGLE_HINT = '请在 chrome://extensions 打开本扩展的详情页, 打开 "Allow User Scripts" 开关 '
  + '(Chrome 138 之前是打开右上角的开发者模式), 然后重新加载扩展'

/**
 * 生成页面侧执行的代码.
 *
 * 单独抽出来是为了可测: 这段代码是一段字符串, 类型系统管不到它, 所以用测试直接检查它
 * 语法正确并且真的能跑出预期结果. 少了这层测试, 一个拼错的字符串只会在用户浏览器里变成
 * 一句难以定位的语法错误.
 *
 * @param expression 模型给的表达式.
 * @returns 可交给 userScripts 执行的代码.
 */
export function buildEvaluateCode(expression: string): string {
  return `(async () => {
  const MAX_DEPTH = 4;
  const MAX_ITEMS = 100;
  const MAX_STRING = 2000;
  const MAX_TOTAL = 20000;
  let truncated = false;
  const seen = new WeakSet();
  const clip = (text) => {
    if (text.length <= MAX_STRING) return text;
    truncated = true;
    return text.slice(0, MAX_STRING) + '...[字符串已截断]';
  };
  const describeNode = (node) => {
    const tag = (node.nodeName || 'node').toLowerCase();
    const id = node.id ? '#' + node.id : '';
    const cls = typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '';
    let text = '';
    try { text = (node.textContent || '').replace(/\\s+/g, ' ').trim(); } catch (e) { text = ''; }
    return '<' + tag + id + cls + '>' + (text ? ' ' + (text.length > 120 ? text.slice(0, 120) + '...' : text) : '');
  };
  const walk = (value, depth) => {
    const type = typeof value;
    if (value === null) return null;
    if (type === 'string') return clip(value);
    if (type === 'number') return Number.isFinite(value) ? value : String(value);
    if (type === 'boolean') return value;
    if (type === 'undefined') return '[undefined]';
    if (type === 'bigint') return value.toString() + 'n';
    if (type === 'symbol') return value.toString();
    if (type === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (depth >= MAX_DEPTH) { truncated = true; return '[已达最大深度 ' + MAX_DEPTH + ']'; }
    if (seen.has(value)) return '[循环引用]';
    seen.add(value);
    if (value instanceof Node) return describeNode(value);
    if (value instanceof Error) return '[Error ' + value.name + ': ' + value.message + ']';
    if (Array.isArray(value)) {
      const head = value.slice(0, MAX_ITEMS).map((item) => walk(item, depth + 1));
      if (value.length > MAX_ITEMS) {
        truncated = true;
        head.push('[还有 ' + (value.length - MAX_ITEMS) + ' 项]');
      }
      return head;
    }
    const out = {};
    let keys = [];
    try { keys = Object.keys(value); } catch (e) { return '[无法读取的对象]'; }
    for (const key of keys.slice(0, MAX_ITEMS)) {
      try { out[key] = walk(value[key], depth + 1); } catch (e) { out[key] = '[读取时抛错: ' + e.message + ']'; }
    }
    if (keys.length > MAX_ITEMS) {
      truncated = true;
      out['...'] = '[还有 ' + (keys.length - MAX_ITEMS) + ' 个字段]';
    }
    return out;
  };
  const result = await (${expression});
  let text;
  try {
    text = JSON.stringify(walk(result, 0), null, 2);
  } catch (e) {
    return { value: '[结果无法序列化: ' + e.message + ']', truncated: true, valueType: typeof result };
  }
  if (typeof text !== 'string') text = String(text);
  if (text.length > MAX_TOTAL) {
    truncated = true;
    text = text.slice(0, MAX_TOTAL) + '\\n...[输出已截断]';
  }
  const valueType = result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result;
  return { value: text, truncated: truncated, valueType: valueType };
})()`
}

/**
 * 把页面返回的结果收敛成三个一定是原始值的字段.
 *
 * 页面侧是我们自己的代码, 但结果仍然要过一遍归一化: 三个字段必须都存在且都是原始值,
 * 否则它又会变成"某个字段是 undefined"那一类跨边界故障 —— 那种故障已经在工具产物上
 * 发生过一次了.
 *
 * @param raw 页面返回的原始结果.
 * @returns 归一化后的求值结果.
 */
export function normalizeEvaluateResult(raw: unknown): EvaluateResult {
  const value = raw as { value?: unknown, truncated?: unknown, valueType?: unknown } | null | undefined
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new PageError('evaluate-failed', `求值没有返回预期的结果形状: ${String(raw)}`)
  }
  return {
    value: typeof value.value === 'string' ? value.value : String(value.value ?? ''),
    truncated: value.truncated === true,
    valueType: typeof value.valueType === 'string' ? value.valueType : 'unknown',
  }
}

/**
 * 在标签页里对一个表达式求值.
 *
 * @param tabId 目标标签页.
 * @param expression 表达式; 支持 await, 需要对象字面量时请用括号包起来.
 * @param world 求值所在的世界.
 * @returns 求值结果.
 */
export async function evaluateInTab(tabId: number, expression: string, world: EvaluateWorld): Promise<EvaluateResult> {
  const api = userScriptsApi()
  if (api === null) {
    throw new PageError(
      'evaluate-unavailable',
      `浏览器求值需要额外的权限开关, 而它现在没打开. ${TOGGLE_HINT}. `
      + '如果不想开这个开关, 可以改用 browser_query 按选择器取数据, 或者用 browser_text 读页面正文',
    )
  }

  const code = buildEvaluateCode(expression)
  let results: UserScriptsInjectionResult[]
  try {
    results = await api.execute({
      target: { tabId },
      js: [{ code }],
      world: world === 'main' ? 'MAIN' : 'USER_SCRIPT',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 开关被中途收回时接口还在, 但调用会失败, 所以这条也要给出同样的指引.
    throw new PageError('evaluate-failed', `求值调用失败: ${message}. ${TOGGLE_HINT}`)
  }

  const first = results[0]
  if (first === undefined) {
    throw new PageError('evaluate-failed', '求值没有返回任何结果, 目标标签页可能没有可注入的文档')
  }
  if (typeof first.error === 'string' && first.error !== '') {
    // 页面里的表达式抛错时, 浏览器把原因放在这里; 原样带回去, 模型据此就能改表达式.
    throw new PageError('evaluate-threw', `页面里的表达式抛错了: ${first.error}`)
  }
  return normalizeEvaluateResult(first.result)
}
