/**
 * 注入到页面里执行的函数.
 *
 * 硬约束: `chrome.scripting.executeScript({ func })` 会把这个函数 toString() 之后
 * 注入页面, 所以函数体不能引用模块作用域里的任何东西 (包括 import 进来的常量,
 * 甚至同文件里定义的其它函数). 需要的东西一律通过参数传入, 需要的工具函数一律
 * 在函数体内部定义.
 *
 * 这些函数运行在 ISOLATED world, 页面自己的 JavaScript 看不到我们挂的变量,
 * 因此页面脚本无法篡改编号表.
 *
 * 为了让编号在多次调用之间有效, 编号表挂在 globalThis 的一个私有属性上, 并由
 * 一个随机 token 标记当次快照; 页码变化后 token 失配, 宿主会收到 stale-target.
 */

/** 编号表在页面里的挂载属性名. */
export const SNAPSHOT_KEY = '__dshBrowserSnapshot'

/** 页面侧一次快照的原始结果. */
export interface RawSnapshot {
  url: string
  title: string
  token: string
  text: string
  elements: { index: number, role: string, name: string, note?: string }[]
  truncated: boolean
}

/**
 * 采集页面结构: 正文文本 + 可交互元素编号表.
 *
 * @param snapshotKey 编号表挂载的属性名.
 * @param maxTextChars 正文文本上限, 超出截断.
 * @param maxElements 元素编号上限, 超出截断.
 * @returns 页面结构, 编号表已写入 globalThis[snapshotKey].
 */
export function collectSnapshot(snapshotKey: string, maxTextChars: number, maxElements: number): RawSnapshot {
  // 以下全部是函数体内的局部定义, 见文件头的注入约束.
  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = globalThis.getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (style.opacity === '0') return false
    return true
  }

  const clip = (value: string, limit: number): string => {
    const flat = value.replace(/\s+/gu, ' ').trim()
    return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`
  }

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role')
    if (explicit !== null && explicit !== '') return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'link-no-href'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      if (type === 'file') return 'file'
      return 'textbox'
    }
    return 'generic'
  }

  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria !== null && aria.trim() !== '') return clip(aria, 160)
    const labelled = el.getAttribute('aria-labelledby')
    if (labelled !== null && labelled !== '') {
      const target = el.ownerDocument.getElementById(labelled)
      if (target !== null) {
        const label = clip(target.textContent ?? '', 160)
        if (label !== '') return label
      }
    }
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const element = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      // 类型为 submit/button 的 input 用 value 当名字, 其余优先用关联 label.
      const type = (el.getAttribute('type') ?? 'text').toLowerCase()
      if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
        const value = (element as HTMLInputElement).value
        if (value !== '') return clip(value, 160)
      }
      const id = el.getAttribute('id')
      if (id !== null && id !== '') {
        const owner = el.ownerDocument
        const escaped = globalThis.CSS.escape(id)
        const label = owner.querySelector(`label[for="${escaped}"]`)
        if (label !== null) {
          const text = clip(label.textContent ?? '', 160)
          if (text !== '') return text
        }
      }
      const placeholder = el.getAttribute('placeholder')
      if (placeholder !== null && placeholder.trim() !== '') return clip(placeholder, 160)
      const name = el.getAttribute('name')
      if (name !== null && name.trim() !== '') return clip(name, 160)
      return ''
    }
    if (tag === 'img') {
      const alt = el.getAttribute('alt')
      if (alt !== null && alt.trim() !== '') return clip(alt, 160)
    }
    const text = clip((el as HTMLElement).innerText ?? el.textContent ?? '', 160)
    if (text !== '') return text
    const title = el.getAttribute('title')
    if (title !== null && title.trim() !== '') return clip(title, 160)
    return ''
  }

  const noteOf = (el: Element): string | undefined => {
    const parts: string[] = []
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase()
      if (type !== 'text') parts.push(type)
      const input = el as HTMLInputElement
      if (input.disabled) parts.push('disabled')
      if (input.readOnly) parts.push('readonly')
      if ((type === 'checkbox' || type === 'radio') && input.checked) parts.push('checked')
      if (input.value !== '' && type !== 'submit' && type !== 'button' && type !== 'password') {
        parts.push(`value=${clip(input.value, 60)}`)
      }
    } else if (tag === 'textarea') {
      const area = el as HTMLTextAreaElement
      if (area.disabled) parts.push('disabled')
      if (area.value !== '') parts.push(`value=${clip(area.value, 60)}`)
    } else if (tag === 'select') {
      const select = el as HTMLSelectElement
      if (select.disabled) parts.push('disabled')
      if (select.multiple) parts.push('multiple')
      const chosen = [...select.selectedOptions].map(option => option.text).join(', ')
      if (chosen !== '') parts.push(`selected=${clip(chosen, 60)}`)
    } else if (tag === 'a') {
      const href = el.getAttribute('href')
      if (href !== null && href !== '') parts.push(`href=${clip(href, 120)}`)
    }
    if (el.hasAttribute('aria-expanded')) {
      parts.push(`expanded=${String(el.getAttribute('aria-expanded'))}`)
    }
    return parts.length === 0 ? undefined : parts.join(' ')
  }

  const interactiveSelector = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    '[role=button]',
    '[role=link]',
    '[role=checkbox]',
    '[role=radio]',
    '[role=tab]',
    '[role=menuitem]',
    '[role=combobox]',
    '[contenteditable=true]',
    '[onclick]',
  ].join(',')

  const body = globalThis.document.body
  const rawText = body === null ? '' : (body.innerText ?? '')
  const text = rawText.length <= maxTextChars ? rawText : `${rawText.slice(0, maxTextChars)}\n... 文本已截断`
  const textTruncated = rawText.length > maxTextChars

  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const elements: RawSnapshot['elements'] = []
  const kept: Element[] = []
  const seen = new Set<Element>()

  for (const candidate of globalThis.document.querySelectorAll(interactiveSelector)) {
    if (elements.length >= maxElements) break
    // 嵌套的可交互元素只保留最外层, 避免同一个控件被列出多次.
    if (seen.has(candidate)) continue
    let ancestor: Element | null = candidate.parentElement
    let nested = false
    while (ancestor !== null) {
      if (seen.has(ancestor)) { nested = true; break }
      ancestor = ancestor.parentElement
    }
    if (nested) continue
    if (!isVisible(candidate)) continue
    const role = roleOf(candidate)
    const name = accessibleName(candidate)
    // 无名又无语义的元素对模型没有用处, 跳过可以显著缩短清单.
    if (name === '' && (role === 'generic' || role === 'link-no-href')) continue
    seen.add(candidate)
    kept.push(candidate)
    const note = noteOf(candidate)
    elements.push(note === undefined
      ? { index: elements.length, role, name }
      : { index: elements.length, role, name, note })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 页面侧私有挂载点.
  ;(globalThis as any)[snapshotKey] = { token, elements: kept }

  return {
    url: globalThis.location.href,
    title: globalThis.document.title,
    token,
    text,
    elements,
    truncated: textTruncated || elements.length >= maxElements,
  }
}

/**
 * 按编号点击.
 *
 * @param snapshotKey 编号表挂载的属性名.
 * @param token 快照 token, 必须与当前编号表一致.
 * @param index 元素编号.
 * @returns 命中说明, 或失败原因 (errors 直接回给宿主).
 */
export function clickElement(snapshotKey: string, token: string, index: number): { ok: true, note: string } | { ok: false, code: string, message: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 页面侧私有挂载点.
  const table = (globalThis as any)[snapshotKey] as { token: string, elements: Element[] } | undefined
  if (table === undefined || table.token !== token) {
    return { ok: false, code: 'stale-target', message: '页面已经变化, 请重新获取快照' }
  }
  const element = table.elements[index]
  if (element === undefined) {
    return { ok: false, code: 'unknown-element', message: `编号 ${index} 不在最近一次快照中` }
  }
  if (!element.isConnected) {
    return { ok: false, code: 'stale-target', message: '该元素已从页面移除, 请重新获取快照' }
  }

  // 从命中的元素向上找到真正可点击的祖先, 例如 <span> 包在 <button> 里.
  const clickableSelector = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[onclick]'
  let target: Element = element
  let ancestor: Element | null = element
  while (ancestor !== null) {
    if (ancestor.matches?.(clickableSelector) === true) { target = ancestor; break }
    ancestor = ancestor.parentElement
  }
  if (typeof (target as HTMLElement).scrollIntoView === 'function') {
    ;(target as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' })
  }

  const describe = (el: Element): string => {
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase()
    const label = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/gu, ' ').trim()
    const href = el.getAttribute('href')
    const suffix = href === null || href === '' ? '' : ` -> ${href}`
    const short = label.length > 60 ? `${label.slice(0, 60)}...` : label
    return `<${role}> ${short}${suffix}`.trim()
  }

  const before = globalThis.location.href
  const tag = target.tagName.toLowerCase()
  const type = (target.getAttribute('type') ?? '').toLowerCase()

  // 勾选类控件用 click() 语义最稳, 因为原生事件会正确翻转 checked.
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    ;(target as HTMLInputElement).click()
    const checked = (target as HTMLInputElement).checked
    return { ok: true, note: `已点击 ${describe(target)}, 当前 checked=${String(checked)} (点击前 url=${before})` }
  }

  // 其余元素派发完整指针序列; 单发 click 事件会被依赖 pointerdown 的框架忽略.
  const rect = target.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  // 事件初始化对象里的 view 需要 Window 类型; 注入环境里它就是全局对象.
  const view = globalThis as unknown as Window
  const base: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view }
  const pointer: PointerEventInit = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }
  target.dispatchEvent(new PointerEvent('pointerdown', pointer))
  target.dispatchEvent(new MouseEvent('mousedown', base))
  ;(target as HTMLElement).focus?.()
  target.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }))
  target.dispatchEvent(new MouseEvent('mouseup', base))
  target.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }))

  return { ok: true, note: `已点击 ${describe(target)} (点击前 url=${before})` }
}

/**
 * 在页面里按键.
 *
 * 目标优先取当前焦点元素; 没有焦点时退到 body, 这样全局快捷键仍然能生效.
 *
 * @param key 按键名, 例如 Enter / Escape / Tab / ArrowDown.
 * @returns 命中说明.
 */
export function pressKeyInPage(key: string): { ok: true, note: string } {
  const active = globalThis.document.activeElement
  const target: Element = active === null || active === globalThis.document.body
    ? globalThis.document.body
    : active
  const describe = target === globalThis.document.body
    ? '<body>'
    : `<${target.tagName.toLowerCase()}>`
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
  const keyCode = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0
  const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true }
  target.dispatchEvent(new KeyboardEvent('keydown', init))
  if (key.length === 1 && key !== ' ') {
    target.dispatchEvent(new KeyboardEvent('keypress', init))
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  return { ok: true, note: `已向 ${describe} 发送按键 ${key}` }
}

/**
 * 滚动页面.
 *
 * @param direction 向上或向下.
 * @param amount 像素数; 省略时滚动一屏.
 * @returns 命中说明, 含滚动前后的位置以便判断是否已经到顶/到底.
 */
export function scrollPage(direction: 'up' | 'down', amount: number | undefined): { ok: true, note: string } {
  const before = globalThis.scrollY
  const step = amount ?? Math.max(200, globalThis.innerHeight * 0.85)
  const delta = direction === 'down' ? step : -step
  globalThis.scrollBy({ top: delta, left: 0, behavior: 'instant' as ScrollBehavior })
  const after = globalThis.scrollY
  const max = Math.max(0, globalThis.document.documentElement.scrollHeight - globalThis.innerHeight)
  const atEdge = direction === 'down' ? after >= max - 1 : after <= 0
  return {
    ok: true,
    note: `滚动 ${direction} ${delta}px: ${Math.round(before)} -> ${Math.round(after)} (可达范围 0..${Math.round(max)})${atEdge ? ', 已到尽头' : ''}`,
  }
}

/**
 * 按编号填入文本, 可选地提交.
 *
 * @param snapshotKey 编号表挂载的属性名.
 * @param token 快照 token.
 * @param index 元素编号.
 * @param text 要填入的文本.
 * @param submit 是否在填入后提交 (Enter 或最近的表单).
 * @returns 命中说明或失败原因.
 */
export function fillElement(snapshotKey: string, token: string, index: number, text: string, submit: boolean): { ok: true, note: string } | { ok: false, code: string, message: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 页面侧私有挂载点.
  const table = (globalThis as any)[snapshotKey] as { token: string, elements: Element[] } | undefined
  if (table === undefined || table.token !== token) {
    return { ok: false, code: 'stale-target', message: '页面已经变化, 请重新获取快照' }
  }
  const element = table.elements[index]
  if (element === undefined) {
    return { ok: false, code: 'unknown-element', message: `编号 ${index} 不在最近一次快照中` }
  }
  if (!element.isConnected) {
    return { ok: false, code: 'stale-target', message: '该元素已从页面移除, 请重新获取快照' }
  }

  const tag = element.tagName.toLowerCase()
  const isEditable = element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false'
  if (tag !== 'input' && tag !== 'textarea' && !isEditable) {
    return { ok: false, code: 'unknown-element', message: `编号 ${index} 是 <${tag}>, 不能填入文本; 请改用点击` }
  }

  const field = element as HTMLInputElement | HTMLTextAreaElement
  const type = (element.getAttribute('type') ?? 'text').toLowerCase()
  if (type === 'file') {
    return { ok: false, code: 'forbidden', message: '文件上传框不能用文本填入, 该操作需要用户手动完成' }
  }

  ;(element as HTMLElement).focus?.()

  if (isEditable) {
    // contenteditable 直接用 insertText 模拟输入法提交, 框架能收到 input 事件.
    const selection = globalThis.getSelection()
    selection?.removeAllRanges()
    const range = globalThis.document.createRange()
    range.selectNodeContents(element)
    selection?.addRange(range)
    selection?.deleteFromDocument()
    const inserted = globalThis.document.execCommand('insertText', false, text)
    if (!inserted) {
      element.textContent = text
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }))
    }
  } else {
    // 走原型上的 value setter, 让 React 一类框架的受控组件能识别到变化.
    const prototype = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    field.focus()
    field.select?.()
    if (setter === undefined) {
      field.value = text
    } else {
      setter.call(field, text)
    }
    field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  }

  let note = `已向编号 ${index} 填入 ${text.length} 个字符`
  if (submit) {
    const form = (element as HTMLInputElement).form ?? null
    ;(element as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
    ;(element as HTMLElement).dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
    note += ', 已按下 Enter'
    if (form !== null) note += ' (该输入框属于一个表单)'
  }
  return { ok: true, note }
}

/** 分块上传的暂存区挂在页面侧的这个属性名上. */
export const UPLOAD_KEY = '__dshBrowserUploads'

/**
 * 按选择器取结构化数据.
 *
 * 这是 `browser_evaluate` 的窄替代: 用选择器表达"要哪些元素", 而不是让模型写任意 JS.
 * 好处是结果形状固定, 一定能过 JSON 边界, 而且在页面 CSP 严格时照样可用.
 *
 * 与快照的区别: 快照只收**可见**的可交互元素并给编号, 供操作使用; 这里收**全部**匹配项
 * (含隐藏元素), 供读数使用. 两者目的不同, 所以不共用一套过滤.
 *
 * @param selector CSS 选择器.
 * @param limit 最多返回多少条.
 * @param maxChars 每条文本与属性值的字符上限.
 * @returns 匹配结果.
 */
export function queryElements(selector: string, limit: number, maxChars: number): {
  ok: true
  url: string
  title: string
  total: number
  truncated: boolean
  items: { index: number, tag: string, text: string, attributes: Record<string, string> }[]
} | { ok: false, code: string, message: string } {
  const clip = (value: string): string => {
    const flat = value.replace(/\s+/gu, ' ').trim()
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}...`
  }

  let matched: Element[]
  try {
    matched = Array.from(globalThis.document.querySelectorAll(selector))
  } catch (error) {
    // 选择器写错是最常见的失败, 直接把浏览器的原因带回去, 比"查询失败"有用得多.
    return {
      ok: false,
      code: 'bad-selector',
      message: `选择器无法解析: ${selector} (${error instanceof Error ? error.message : String(error)})`,
    }
  }

  const kept = matched.slice(0, limit)
  const items = kept.map((element, index) => {
    const attributes: Record<string, string> = {}
    for (const attribute of Array.from(element.attributes)) {
      attributes[attribute.name] = clip(attribute.value)
    }
    // 优先 innerText (它反映渲染后的文本); 用鸭子类型判断而不是 `instanceof HTMLElement`,
    // 因为 SVG 元素与 MathML 元素本来就不是 HTMLElement, 而它们在页面上同样常见.
    const candidate = element as { innerText?: unknown }
    const raw = typeof candidate.innerText === 'string' ? candidate.innerText : (element.textContent ?? '')
    return {
      index,
      tag: element.tagName.toLowerCase(),
      text: clip(raw),
      attributes,
    }
  })

  return {
    ok: true,
    url: globalThis.location.href,
    title: globalThis.document.title,
    total: matched.length,
    truncated: matched.length > kept.length,
    items,
  }
}

/**
 * 悬停到一个编号元素上.
 *
 * 点击与悬停是两种不同的交互: 下拉菜单, 悬浮提示, 以及"删除按钮只在 hover 后出现"这类
 * 界面都只认鼠标移入, 单靠 click 到不了. 所以这里派发完整的移入序列, 顺序与真实鼠标
 * 一致 (先 pointerover/pointerenter, 再 mouseover/mousemove/mouseenter).
 *
 * @param snapshotKey 编号表挂载的属性名.
 * @param token 快照编号.
 * @param index 元素编号.
 * @returns 悬停说明.
 */
export function hoverElement(snapshotKey: string, token: string, index: number): { ok: true, note: string } | { ok: false, code: string, message: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 页面侧私有挂载点.
  const table = (globalThis as any)[snapshotKey] as { token: string, elements: Element[] } | undefined
  if (table === undefined || table.token !== token) {
    return { ok: false, code: 'stale-target', message: '页面已经变化, 请重新获取快照' }
  }
  const element = table.elements[index]
  if (element === undefined) {
    return { ok: false, code: 'unknown-element', message: `编号 ${index} 不在最近一次快照中` }
  }
  if (!element.isConnected) {
    return { ok: false, code: 'stale-target', message: '该元素已从页面移除, 请重新获取快照' }
  }

  const describe = (el: Element): string => {
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase()
    const label = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/gu, ' ').trim()
    const short = label.length > 60 ? `${label.slice(0, 60)}...` : label
    return `<${role}> ${short}`.trim()
  }

  if (typeof (element as HTMLElement).scrollIntoView === 'function') {
    ;(element as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' })
  }
  const rect = element.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  // 事件初始化对象里的 view 需要 Window 类型; 注入环境里它就是全局对象.
  const view = globalThis as unknown as Window
  const base: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view }
  const pointer: PointerEventInit = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: -1, buttons: 0 }
  element.dispatchEvent(new PointerEvent('pointerover', pointer))
  element.dispatchEvent(new PointerEvent('pointerenter', { ...pointer, bubbles: false }))
  element.dispatchEvent(new MouseEvent('mouseover', base))
  element.dispatchEvent(new MouseEvent('mousemove', base))
  element.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }))

  return { ok: true, note: `已悬停到 ${describe(element)}; 若依赖它出现菜单, 请用 browser_snapshot 确认是否出现新元素` }
}

/**
 * 开始暂存一个待上传的文件.
 *
 * 上传走分块而不是单次传输, 原因是硬限制: Chrome 对 native messaging 从宿主发往扩展的
 * 单条消息限制在 1 MB, 而一个文件往往大于它. 所以宿主按块发, 页面侧先暂存, 最后一次性
 * 组装成 File.
 *
 * @param uploadKey 暂存区挂载的属性名.
 * @param name 文件名.
 * @param mime MIME 类型.
 * @param bytes 文件总字节数, 收尾时用来校验.
 * @returns 本次暂存的 id.
 */
export function uploadBegin(uploadKey: string, name: string, mime: string, bytes: number): { ok: true, uploadId: string, note: string } | { ok: false, code: string, message: string } {
  if (typeof bytes !== 'number' || bytes < 0) {
    return { ok: false, code: 'internal', message: `文件字节数无效: ${String(bytes)}` }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 页面侧私有挂载点.
  const store = ((globalThis as any)[uploadKey] ??= { sequence: 0, pending: {} }) as {
    sequence: number
    pending: Record<string, { name: string, mime: string, bytes: number, chunks: Uint8Array[], received: number }>
  }
  store.sequence += 1
  const uploadId = `up-${String(store.sequence)}-${String(Date.now())}`
  store.pending[uploadId] = { name, mime, bytes, chunks: [], received: 0 }
  return { ok: true, uploadId, note: `已开始接收 ${name} (${String(bytes)} 字节)` }
}

/**
 * 追加一块文件内容.
 *
 * @param uploadKey 暂存区挂载的属性名.
 * @param uploadId 暂存 id.
 * @param data base64 编码的字节.
 * @returns 已收到的字节数.
 */
export function uploadChunk(uploadKey: string, uploadId: string, data: string): { ok: true, received: number, note: string } | { ok: false, code: string, message: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 页面侧私有挂载点.
  const store = (globalThis as any)[uploadKey] as { pending: Record<string, { name: string, bytes: number, chunks: Uint8Array[], received: number }> } | undefined
  const entry = store?.pending[uploadId]
  if (entry === undefined) {
    return { ok: false, code: 'internal', message: `没有找到上传 ${uploadId} 的暂存区, 请重新开始上传` }
  }
  let binary: string
  try {
    binary = globalThis.atob(data)
  } catch (error) {
    return { ok: false, code: 'internal', message: `分块不是合法的 base64: ${error instanceof Error ? error.message : String(error)}` }
  }
  const chunk = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) chunk[i] = binary.charCodeAt(i) & 0xff
  entry.chunks.push(chunk)
  entry.received += chunk.length
  if (entry.received > entry.bytes) {
    return { ok: false, code: 'internal', message: `收到的内容 (${String(entry.received)} 字节) 超过了声明的 ${String(entry.bytes)} 字节` }
  }
  return { ok: true, received: entry.received, note: `${entry.name} 已收到 ${String(entry.received)}/${String(entry.bytes)} 字节` }
}

/**
 * 把暂存的字节变成真正的 File 并装进文件输入框.
 *
 * 为什么不用路径: 浏览器不允许脚本给 `input[type=file]` 指派磁盘路径 —— 否则网页就能
 * 悄悄上传任意本地文件. 但**允许**指派由内容构造出来的 File 对象, 因为内容本来就是
 * 调用方自己给的. 所以这里把宿主读到的字节在页面里重建为 File, 再经 DataTransfer 装进
 * 输入框并派发 change, 效果与用户选文件一致, 全程不碰调试协议.
 *
 * 目标用选择器而不是快照编号: 文件输入框几乎总是被藏起来 (点按钮才能触发), 而快照只收
 * 可见元素, 用编号会找不到它.
 *
 * @param uploadKey 暂存区挂载的属性名.
 * @param selector 目标文件输入框的选择器.
 * @param nth 同名匹配里的第几个, 从 0 开始.
 * @param uploadIds 要装入的暂存 id, 按顺序.
 * @returns 装入结果.
 */
export function uploadCommit(uploadKey: string, selector: string, nth: number, uploadIds: string[]): {
  ok: true
  files: { name: string, bytes: number, mime: string }[]
  note: string
} | { ok: false, code: string, message: string } {
  let candidates: Element[]
  try {
    candidates = Array.from(globalThis.document.querySelectorAll(selector))
  } catch (error) {
    return {
      ok: false,
      code: 'bad-selector',
      message: `选择器无法解析: ${selector} (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  const inputs = candidates.filter((element) => element.tagName === 'INPUT' && (element as HTMLInputElement).type === 'file')
  if (inputs.length === 0) {
    return {
      ok: false,
      code: 'unknown-element',
      message: `选择器 ${selector} 没有匹配到 input[type=file]. 页面上现有 ${String(candidates.length)} 个元素匹配该选择器, 但都不是文件输入框`,
    }
  }
  const input = inputs[nth] as HTMLInputElement | undefined
  if (input === undefined) {
    return { ok: false, code: 'unknown-element', message: `选择器 ${selector} 匹配到 ${String(inputs.length)} 个文件输入框, 没有第 ${String(nth)} 个` }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 页面侧私有挂载点.
  const store = (globalThis as any)[uploadKey] as { pending: Record<string, { name: string, mime: string, bytes: number, chunks: Uint8Array[], received: number }> } | undefined
  if (store === undefined) {
    return { ok: false, code: 'internal', message: '暂存区不见了, 页面可能已经重新加载, 请重新上传' }
  }

  const built: File[] = []
  for (const uploadId of uploadIds) {
    const entry = store.pending[uploadId]
    if (entry === undefined) {
      return { ok: false, code: 'internal', message: `没有找到上传 ${uploadId} 的内容, 请重新开始上传` }
    }
    if (entry.received !== entry.bytes) {
      return {
        ok: false,
        code: 'internal',
        message: `${entry.name} 只收到 ${String(entry.received)}/${String(entry.bytes)} 字节, 内容不完整, 未装入输入框`,
      }
    }
    const merged = new Uint8Array(entry.received)
    let offset = 0
    for (const chunk of entry.chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    built.push(new File([merged], entry.name, { type: entry.mime }))
  }

  if (built.length > 1 && !input.multiple) {
    return {
      ok: false,
      code: 'unknown-element',
      message: `该输入框不接受多文件, 但这次准备了 ${String(built.length)} 个; 请只传一个文件`,
    }
  }

  const transfer = new DataTransfer()
  for (const file of built) transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))

  const actual = Array.from(input.files ?? []).map(file => ({ name: file.name, bytes: file.size, mime: file.type }))
  if (actual.length !== built.length) {
    // 指派被页面自己清掉或改写时如实说明, 不要让调用方以为装进去了.
    return {
      ok: false,
      code: 'internal',
      message: `已尝试装入 ${String(built.length)} 个文件, 但输入框当前只剩 ${String(actual.length)} 个, 页面可能自行重置了选择`,
    }
  }

  for (const uploadId of uploadIds) delete store.pending[uploadId]
  const summary = actual.map(file => `${file.name} (${String(file.bytes)} 字节)`).join(', ')
  return {
    ok: true,
    files: actual,
    note: `已装入 ${String(actual.length)} 个文件: ${summary}. 若表单需要提交, 请再点提交按钮`,
  }
}

/**
 * 丢弃暂存的上传内容.
 *
 * 上传中途失败时调用, 避免把半个文件留在页面侧占内存.
 *
 * @param uploadKey 暂存区挂载的属性名.
 * @param uploadIds 要丢弃的暂存 id.
 * @returns 丢弃数量.
 */
export function uploadAbort(uploadKey: string, uploadIds: string[]): { ok: true, aborted: number, note: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 页面侧私有挂载点.
  const store = (globalThis as any)[uploadKey] as { pending: Record<string, unknown> } | undefined
  let aborted = 0
  for (const uploadId of uploadIds) {
    if (store !== undefined && store.pending[uploadId] !== undefined) {
      delete store.pending[uploadId]
      aborted += 1
    }
  }
  return { ok: true, aborted, note: `已丢弃 ${String(aborted)} 个未完成的上传` }
}
