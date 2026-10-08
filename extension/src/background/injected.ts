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
