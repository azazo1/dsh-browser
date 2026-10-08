/**
 * 注入函数的自包含性测试.
 *
 * 这是本插件最容易静默失效的一处: 注入函数会被 `chrome.scripting.executeScript`
 * toString() 之后送进页面执行, 一旦它引用了定义在模块作用域里的任何东西 —— 一个
 * 常量, 一个辅助函数, 或者打包器插入的 helper —— 函数在页面里就会抛
 * ReferenceError. 这种失败在真实浏览器里表现为"取快照没反应", 很难定位.
 *
 * 因此这里不测逻辑, 只测**函数在失去闭包之后还能不能跑**: 把源码字符串放进一个
 * 干净的函数里求值 (没有模块作用域), 用最小 DOM 桩跑一遍, 看是否真的能产出结果.
 */

import { describe, expect, it } from 'vitest'
import {
  SNAPSHOT_KEY,
  clickElement,
  collectSnapshot,
  fillElement,
  pressKeyInPage,
  scrollPage,
} from '../extension/src/background/injected.ts'

/**
 * 在"没有闭包"的环境里求值一个注入函数.
 *
 * `new Function` 只能看到全局作用域, 所以任何对模块作用域的引用都会立刻暴露成
 * ReferenceError, 这正是我们要复现的真实条件.
 *
 * @param fn 要测的注入函数.
 * @param args 传给它的参数.
 * @returns 函数返回值.
 */
function callWithoutClosure<T>(fn: (...args: never[]) => T, args: unknown[]): T {
  const source = fn.toString()
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 这里就是要复现字符串化执行.
  const rebuilt = new Function(`return (${source})`)() as (...args: unknown[]) => T
  return rebuilt(...args)
}

/** 造一个够用的 DOM 桩, 只实现注入函数真正用到的那部分. */
function installDomStub(): void {
  const globalStub = globalThis as unknown as Record<string, unknown>

  // fillElement 走原型上的 value setter 来触发受控组件 (React 一类) 的识别, 所以要
  // 提供这两个构造器与它们的 value 访问器. 它们都是页面全局, 不是模块作用域的东西.
  const elementClasses = new Map<string, { prototype: object }>()
  for (const name of ['HTMLInputElement', 'HTMLTextAreaElement']) {
    class ElementStub {}
    Object.defineProperty(ElementStub.prototype, 'value', {
      configurable: true,
      get(this: { _value?: string }) { return this._value ?? '' },
      set(this: { _value?: string }, next: string) { this._value = next },
    })
    globalStub[name] = ElementStub
    elementClasses.set(name, ElementStub)
  }

  const makeElement = (tag: string, attrs: Record<string, string> = {}, text = ''): Record<string, unknown> => {
    const element: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      isConnected: true,
      parentElement: null,
      ownerDocument: undefined,
      _attrs: attrs,
      _text: text,
      _listeners: [] as string[],
      getAttribute: (name: string) => attrs[name] ?? null,
      hasAttribute: (name: string) => Object.hasOwn(attrs, name),
      setAttribute: (name: string, value: string) => { attrs[name] = value },
      matches: () => tag === 'button' || tag === 'input',
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 }),
      dispatchEvent: (event: { type: string }) => { (element._listeners as string[]).push(event.type); return true },
      scrollIntoView: () => {},
      focus: () => {},
      select: () => {},
      click: () => { (element._listeners as string[]).push('click') },
      addEventListener: () => {},
      innerText: text,
      textContent: text,
      disabled: false,
      readOnly: false,
      checked: false,
    }
    // input 与 textarea 必须让原型上的 value 访问器生效, 所以不能带同名的自有属性.
    if (tag === 'input') Object.setPrototypeOf(element, elementClasses.get('HTMLInputElement')?.prototype ?? Object.prototype)
    if (tag === 'textarea') Object.setPrototypeOf(element, elementClasses.get('HTMLTextAreaElement')?.prototype ?? Object.prototype)
    return element
  }

  const button = makeElement('button', { 'aria-label': '提交' }, '提交')
  const input = makeElement('input', { type: 'text', name: 'q' })
  const body = makeElement('body', {}, '页面正文')
  const documentStub = {
    body,
    title: '测试页',
    activeElement: body,
    documentElement: { scrollHeight: 2_000 },
    createRange: () => ({ selectNodeContents: () => {}, collapse: () => {} }),
    execCommand: () => true,
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector.includes('button') ? [button, input] : []),
    getElementById: () => null,
  }
  // element.ownerDocument 不能进原型链, 直接挂在对象上.
  Object.defineProperty(button, 'ownerDocument', { value: documentStub, enumerable: false })
  Object.defineProperty(input, 'ownerDocument', { value: documentStub, enumerable: false })

  globalStub.document = documentStub
  globalStub.location = { href: 'https://example.com/page' }
  globalStub.innerHeight = 800
  globalStub.scrollY = 0
  globalStub.scrollBy = () => { globalStub.scrollY = 400 }
  globalStub.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' })
  globalStub.CSS = { escape: (value: string) => value }
  globalStub.PointerEvent = class { constructor(public type: string) {} }
  globalStub.MouseEvent = class { constructor(public type: string) {} }
  globalStub.KeyboardEvent = class { constructor(public type: string) {} }
  globalStub.InputEvent = class { constructor(public type: string) {} }
  globalStub.Event = class { constructor(public type: string) {} }
  globalStub.getSelection = () => null
  globalStub.devicePixelRatio = 1
}

describe('注入函数在失去闭包后仍可执行', () => {
  it('collectSnapshot 不引用模块作用域的任何东西', () => {
    installDomStub()
    const result = callWithoutClosure(collectSnapshot, [SNAPSHOT_KEY, 10_000, 50])
    expect(result.url).toBe('https://example.com/page')
    expect(result.title).toBe('测试页')
    expect(result.token).not.toBe('')
    expect(result.text).toContain('页面正文')
    // 编号表必须挂到页面上, 否则后续 click / fill 无法寻址.
    const table = (globalThis as unknown as Record<string, { token: string, elements: unknown[] }>)[SNAPSHOT_KEY]
    expect(table.token).toBe(result.token)
    expect(table.elements).toHaveLength(2)
  })

  it('编号从 0 开始且与元素清单一一对应', () => {
    installDomStub()
    const result = callWithoutClosure(collectSnapshot, [SNAPSHOT_KEY, 10_000, 50])
    expect(result.elements.map(element => element.index)).toEqual([0, 1])
    // 第二个是 input, 名字来自 name 属性.
    expect(result.elements[1]?.role).toBe('textbox')
    expect(result.elements[1]?.name).toBe('q')
  })

  it('token 不一致时拒绝点击, 而不是点到错的元素', () => {
    installDomStub()
    const snapshot = callWithoutClosure(collectSnapshot, [SNAPSHOT_KEY, 10_000, 50])
    const stale = callWithoutClosure(clickElement, [SNAPSHOT_KEY, 'outdated-token', 0])
    expect(stale).toMatchObject({ ok: false, code: 'stale-target' })
    // 用当前 token 就能点中.
    const fresh = callWithoutClosure(clickElement, [SNAPSHOT_KEY, snapshot.token, 0])
    expect(fresh).toMatchObject({ ok: true })
  })

  it('编号越界时报 unknown-element', () => {
    installDomStub()
    const snapshot = callWithoutClosure(collectSnapshot, [SNAPSHOT_KEY, 10_000, 50])
    const missing = callWithoutClosure(clickElement, [SNAPSHOT_KEY, snapshot.token, 99])
    expect(missing).toMatchObject({ ok: false, code: 'unknown-element' })
  })

  it('向不可编辑元素填入时报错, 而不是静默失败', () => {
    installDomStub()
    const snapshot = callWithoutClosure(collectSnapshot, [SNAPSHOT_KEY, 10_000, 50])
    // 编号 0 是 button.
    const rejected = callWithoutClosure(fillElement, [SNAPSHOT_KEY, snapshot.token, 0, 'x', false])
    expect(rejected).toMatchObject({ ok: false, code: 'unknown-element' })
  })

  it('向输入框填入并派发 input 事件', () => {
    installDomStub()
    const snapshot = callWithoutClosure(collectSnapshot, [SNAPSHOT_KEY, 10_000, 50])
    const input = (( globalThis as unknown as Record<string, { elements: Record<string, unknown>[] }>)[SNAPSHOT_KEY]).elements[1]
    const filled = callWithoutClosure(fillElement, [SNAPSHOT_KEY, snapshot.token, 1, '关键词', true])
    expect(filled).toMatchObject({ ok: true })
    expect(input?.value).toBe('关键词')
    expect(input?._listeners).toContain('input')
  })

  it('按键与滚动都可独立执行', () => {
    installDomStub()
    expect(callWithoutClosure(pressKeyInPage, ['Enter'])).toMatchObject({ ok: true })
    const scrolled = callWithoutClosure(scrollPage, ['down', 300])
    expect(scrolled).toMatchObject({ ok: true })
    expect(scrolled.note).toContain('300')
  })
})
