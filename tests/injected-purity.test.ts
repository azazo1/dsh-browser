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
  UPLOAD_KEY,
  clickElement,
  collectSnapshot,
  fillElement,
  hoverElement,
  pressKeyInPage,
  queryElements,
  scrollPage,
  uploadAbort,
  uploadBegin,
  uploadChunk,
  uploadCommit,
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
      // queryElements 读的是元素的属性表, 形态要跟 DOM 一致 (NamedNodeMap 里每项有 name/value).
      attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
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
      files: null,
      multiple: false,
      // 真实 DOM 里 input.type 是属性, 读它比读 attribute 更常见.
      type: attrs['type'] ?? '',
    }
    // input 与 textarea 必须让原型上的 value 访问器生效, 所以不能带同名的自有属性.
    if (tag === 'input') Object.setPrototypeOf(element, elementClasses.get('HTMLInputElement')?.prototype ?? Object.prototype)
    if (tag === 'textarea') Object.setPrototypeOf(element, elementClasses.get('HTMLTextAreaElement')?.prototype ?? Object.prototype)
    return element
  }

  const button = makeElement('button', { 'aria-label': '提交' }, '提交')
  const input = makeElement('input', { type: 'text', name: 'q' })
  const body = makeElement('body', {}, '页面正文')
  // 文件输入框通常是被藏起来的, 所以它不在快照里, 只能按选择器找.
  const fileInput = makeElement('input', { type: 'file', name: 'upload' })
  fileInput.multiple = true
  const documentStub = {
    body,
    title: '测试页',
    activeElement: body,
    documentElement: { scrollHeight: 2_000 },
    createRange: () => ({ selectNodeContents: () => {}, collapse: () => {} }),
    execCommand: () => true,
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector.includes('file')) return [fileInput]
      return selector.includes('button') ? [button, input] : []
    },
    getElementById: () => null,
  }
  // element.ownerDocument 不能进原型链, 直接挂在对象上.
  Object.defineProperty(button, 'ownerDocument', { value: documentStub, enumerable: false })
  Object.defineProperty(input, 'ownerDocument', { value: documentStub, enumerable: false })
  Object.defineProperty(fileInput, 'ownerDocument', { value: documentStub, enumerable: false })

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
  // 上传要把字节重建成真实 File 再装进输入框; Node 没有 DataTransfer, 而 File 的
  // 行为这里只需要 name/size/type, 索性两者都给确定性桩.
  globalStub.File = class {
    name: string
    size: number
    type: string
    constructor(parts: { length: number }[], name: string, options?: { type?: string }) {
      this.name = name
      this.size = parts.reduce((total, part) => total + part.length, 0)
      this.type = options?.type ?? ''
    }
  }
  globalStub.DataTransfer = class {
    files: unknown[] = []
    items = { add: (file: unknown) => { this.files.push(file) } }
  }
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

  it('queryElements 按选择器取值, 并把属性一并带回', () => {
    installDomStub()
    const result = callWithoutClosure(queryElements, ['button', 50, 100])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.url).toBe('https://example.com/page')
    expect(result.title).toBe('测试页')
    // 快照只收可见可交互元素, 取值则返回全部匹配项 —— 两者目的不同.
    expect(result.total).toBe(2)
    expect(result.items[0]?.tag).toBe('button')
    expect(result.items[0]?.attributes['aria-label']).toBe('提交')
    expect(result.items[1]?.tag).toBe('input')
  })

  it('queryElements 的 limit 生效, 并如实报告被截断', () => {
    installDomStub()
    const result = callWithoutClosure(queryElements, ['button', 1, 100])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items).toHaveLength(1)
    expect(result.total).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('queryElements 遇到非法选择器时返回可读原因, 而不是抛错', () => {
    installDomStub()
    // 让 querySelectorAll 抛错, 复现选择器语法错误 (真实 DOM 会抛 SyntaxError).
    ;(globalThis as unknown as { document: { querySelectorAll: () => unknown } }).document.querySelectorAll = () => {
      throw new Error('is not a valid selector')
    }
    const result = callWithoutClosure(queryElements, ['!!!', 50, 100])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('bad-selector')
    expect(result.message).toContain('is not a valid selector')
  })

  it('hoverElement 派发完整移入序列 (顺序与真实鼠标一致)', () => {
    installDomStub()
    const snapshot = callWithoutClosure(collectSnapshot, [SNAPSHOT_KEY, 10_000, 50])
    const result = callWithoutClosure(hoverElement, [SNAPSHOT_KEY, snapshot.token, 0])
    expect(result.ok).toBe(true)
    const button = (globalThis as unknown as {
      document: { querySelectorAll: (s: string) => { _listeners: string[] }[] }
    }).document.querySelectorAll('button')[0]
    // 依赖 pointerover 的框架与依赖 mouseover 的老代码都要能收到, 所以两边都派发;
    // 顺序与真实鼠标一致, 免得只认第一个事件的实现被漏掉.
    expect(button?._listeners).toEqual(['pointerover', 'pointerenter', 'mouseover', 'mousemove', 'mouseenter'])
    expect(result.note).toContain('已悬停到')
  })

  it('hoverElement 在快照编号过期时拒绝', () => {
    installDomStub()
    callWithoutClosure(collectSnapshot, [SNAPSHOT_KEY, 10_000, 50])
    const result = callWithoutClosure(hoverElement, [SNAPSHOT_KEY, 'stale', 0])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('stale-target')
  })

  it('上传: 分块收齐后装进 input.files 并派发 change', () => {
    installDomStub()
    // 'hello' 的 base64.
    const payload = 'aGVsbG8='
    const begin = callWithoutClosure(uploadBegin, [UPLOAD_KEY, 'note.txt', 'text/plain', 5])
    expect(begin.ok).toBe(true)
    if (!begin.ok) return
    const chunk = callWithoutClosure(uploadChunk, [UPLOAD_KEY, begin.uploadId, payload])
    expect(chunk.ok).toBe(true)
    if (!chunk.ok) return
    expect(chunk.received).toBe(5)

    const commit = callWithoutClosure(uploadCommit, [UPLOAD_KEY, 'input[type=file]', 0, [begin.uploadId]])
    expect(commit.ok).toBe(true)
    if (!commit.ok) return
    // 字节必须是宿主读到的真实内容, 而不是空文件.
    expect(commit.files).toEqual([{ name: 'note.txt', bytes: 5, mime: 'text/plain' }])
    const input = (globalThis as unknown as { document: { querySelectorAll: (s: string) => Record<string, unknown>[] } })
      .document.querySelectorAll('file')[0]
    expect((input?.files as unknown[]).length).toBe(1)
    // 页面要收到 change, 否则表单不会认为自己被填过.
    expect((input?._listeners as string[])).toContain('change')
  })

  it('上传: 内容没收齐时拒绝装入, 不留下半个文件', () => {
    installDomStub()
    const begin = callWithoutClosure(uploadBegin, [UPLOAD_KEY, 'big.bin', 'application/octet-stream', 100])
    expect(begin.ok).toBe(true)
    if (!begin.ok) return
    callWithoutClosure(uploadChunk, [UPLOAD_KEY, begin.uploadId, 'aGVsbG8='])
    const commit = callWithoutClosure(uploadCommit, [UPLOAD_KEY, 'input[type=file]', 0, [begin.uploadId]])
    expect(commit.ok).toBe(false)
    if (commit.ok) return
    expect(commit.message).toContain('内容不完整')
  })

  it('上传: abort 清掉暂存, 之后 commit 找不到内容', () => {
    installDomStub()
    const begin = callWithoutClosure(uploadBegin, [UPLOAD_KEY, 'tmp.txt', 'text/plain', 5])
    expect(begin.ok).toBe(true)
    if (!begin.ok) return
    const aborted = callWithoutClosure(uploadAbort, [UPLOAD_KEY, [begin.uploadId]])
    expect(aborted.aborted).toBe(1)
    const commit = callWithoutClosure(uploadCommit, [UPLOAD_KEY, 'input[type=file]', 0, [begin.uploadId]])
    expect(commit.ok).toBe(false)
  })
})
