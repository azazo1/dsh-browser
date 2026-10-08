/**
 * 打包产物里注入函数的纯净性检查.
 *
 * 前一个测试证明的是 TypeScript 源码里的注入函数没有闭包依赖; 但真正送进页面执行的是
 * `assets/extension/background.js` 里的那一份. 打包器在降级语法时可能插入模块级 helper
 * (例如对象展开的 __spreadValues), 一旦注入函数的函数体引用了它们, 字符串化进页面后
 * 就会 ReferenceError —— 而源码测试看不到这件事.
 *
 * 所以这个测试直接从产物里把函数体抠出来求值, 用和源码测试同一套 DOM 桩跑一遍.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/** 产物路径; 相对本测试文件定位, 不依赖运行目录. */
const BUNDLE = join(import.meta.dirname, '..', 'assets', 'extension', 'background.js')

/**
 * 从产物里抠出一个函数声明或函数表达式的源码.
 *
 * 用括号配平而不是正则, 因为函数体里必然出现嵌套的大括号与字符串.
 *
 * @param source 产物全文.
 * @param name 函数名.
 * @returns 函数源码; 找不到时抛错.
 */
function extractFunction(source: string, name: string): string {
  const patterns = [`function ${name}(`, `const ${name} = function`, `${name} = (`]
  let start = -1
  for (const pattern of patterns) {
    start = source.indexOf(pattern)
    if (start !== -1) break
  }
  if (start === -1) throw new Error(`产物里找不到函数 ${name}`)

  // 从函数体的第一个 '{' 开始配平; 字符串与注释里的括号需要跳过.
  const bodyStart = source.indexOf('{', start)
  if (bodyStart === -1) throw new Error(`函数 ${name} 没有函数体`)
  let depth = 0
  let index = bodyStart
  let quote: string | null = null
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== null) {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  if (depth !== 0) throw new Error(`函数 ${name} 的大括号没有配平`)
  // 用 "函数名 = 源码" 的形式重建, 便于 new Function 求值.
  return source.slice(start, index + 1)
}

/** 与源码测试一致的 DOM 桩; 这里只需要够 collectSnapshot 跑起来. */
function installDomStub(): void {
  const globalStub = globalThis as unknown as Record<string, unknown>
  const makeElement = (tag: string, attrs: Record<string, string> = {}, text = ''): Record<string, unknown> => ({
    tagName: tag.toUpperCase(),
    isConnected: true,
    parentElement: null,
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => Object.hasOwn(attrs, name),
    matches: () => tag === 'button',
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 }),
    dispatchEvent: () => true,
    scrollIntoView: () => {},
    focus: () => {},
    innerText: text,
    textContent: text,
  })
  const button = makeElement('button', { 'aria-label': '提交' }, '提交')
  const documentStub = {
    body: makeElement('body', {}, '产物侧正文'),
    title: '打包产物测试',
    activeElement: null,
    documentElement: { scrollHeight: 1_000 },
    createRange: () => ({ selectNodeContents: () => {} }),
    execCommand: () => true,
    querySelector: () => null,
    querySelectorAll: () => [button],
    getElementById: () => null,
  }
  globalStub.document = documentStub
  globalStub.location = { href: 'https://example.com/bundled' }
  globalStub.innerHeight = 800
  globalStub.scrollY = 0
  globalStub.scrollBy = () => {}
  globalStub.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' })
  globalStub.CSS = { escape: (value: string) => value }
  globalStub.PointerEvent = class { constructor(public type: string) {} }
  globalStub.MouseEvent = class { constructor(public type: string) {} }
  globalStub.KeyboardEvent = class { constructor(public type: string) {} }
  globalStub.InputEvent = class { constructor(public type: string) {} }
  globalStub.Event = class { constructor(public type: string) {} }
}

describe('打包产物里的注入函数仍然自包含', () => {
  let bundle = ''

  beforeAll(() => {
    bundle = readFileSync(BUNDLE, 'utf8')
  })

  it('background.js 存在且包含注入函数', () => {
    expect(bundle.length).toBeGreaterThan(1_000)
    expect(bundle).toContain('collectSnapshot')
  })

  it('collectSnapshot 在产物形态下可无闭包执行', () => {
    installDomStub()
    const source = extractFunction(bundle, 'collectSnapshot')
    // 函数体里不能引用模块级 helper; 常见的打包器 helper 名字在这里显式排除.
    for (const helper of ['__spreadValues', '__spreadProps', '__defProp', '__pow', '__async']) {
      expect(source, `注入函数引用了打包器 helper ${helper}`).not.toContain(helper)
    }
    const rebuilt = new Function(`return (${source})`)() as (key: string, max: number, maxElements: number) => {
      url: string
      token: string
      elements: unknown[]
    }
    const result = rebuilt('__dshBundleTest', 10_000, 10)
    expect(result.url).toBe('https://example.com/bundled')
    expect(result.token).not.toBe('')
    expect(result.elements).toHaveLength(1)
  })

  it('扩展清单的 key 字段存在, 扩展 id 可稳定派生', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'assets', 'extension', 'manifest.json'), 'utf8')) as { key?: string }
    expect(typeof manifest.key).toBe('string')
    expect(manifest.key).not.toBe('')
  })
})
