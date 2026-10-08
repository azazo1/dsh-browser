/**
 * 工具产物契约: 每个 browser_* 工具的返回值必须是 harness 认可的形状.
 *
 * 这个测试守的是一个真实发生过的故障, 而且它在类型层面**看不出来**:
 *
 * `shared/methods.ts` 声明 `page.click` 返回 `{ ok: true, note }`, 但扩展实现只返回
 * `{ note }`. 于是工具里读到的 `result.ok` 是 `undefined`, 拼进产物对象后又多出一个
 * `ok: undefined` 字段. harness 在把产物落进会话日志前会做一次 lossless-JSON 快照
 * (`snapshotJsonValue`), 而 `undefined` 不是合法 JSON 值 —— 于是四个操作工具
 * (click / fill / press_key / scroll) **全部**被拒:
 *
 *   tool "browser_click" returned invalid output: value is not lossless JSON
 *
 * 最阴的地方是动作其实成功了 (页面确实被点到了), 只有返回值被丢掉, 所以现象是"操作生效
 * 但报错". 两侧由一份声明连接, 实现却不受它约束, TypeScript 完全看不到这层不一致.
 *
 * 所以这里用**生产环境用的同一个校验器**逐个跑一遍真实的 execute 路径: 桩只替换
 * 扩展那一层, 返回的形状严格照抄扩展实现, 然后验证产物既能通过 lossless 快照, 又符合
 * 工具自己声明的 output.schema.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { advancedTools } from '../src/tools/advanced.ts'
import { pageTools } from '../src/tools/page.ts'
import { screenshotTool } from '../src/tools/screenshot.ts'
import { sessionTools } from '../src/tools/session.ts'
import type { BrowserResource, BrowserRuntime } from '../src/runtime.ts'
import type { BrowserMethod } from '../shared/methods.ts'

/** 扩展各方法的返回形状, 严格照抄 extension/src/background/{page,tabs}.ts 的实现. */
const EXTENSION_RESULTS: Record<string, unknown> = {
  'tabs.list': [
    { id: 1391393307, url: 'https://www.google.com/', title: 'Google', active: true, windowId: 1 },
    { id: 1391393272, url: 'chrome://extensions/', title: '扩展程序', active: false, windowId: 1 },
  ],
  'tabs.activate': { id: 1391393307, url: 'https://www.google.com/', title: 'Google', active: true, windowId: 1 },
  'tabs.open': { id: 1, url: 'https://example.com/', title: 'Example', active: true, windowId: 1 },
  // page.ts 的四个操作方法都是 `return { note: unwrap(value).note }` —— 没有 ok.
  'page.click': { note: '已点击 <button> 搜索' },
  'page.fill': { note: '已向编号 7 填入 4 个字符, 已按下 Enter' },
  'page.pressKey': { note: '已向 <body> 发送按键 Enter' },
  'page.scroll': { note: '滚动 down 850px: 0 -> 850 (可达范围 0..3000)' },
  'page.navigate': { url: 'https://www.google.com/', title: 'Google' },
  'page.text': {
    url: 'https://www.google.com/',
    title: 'Google',
    text: '页面正文内容',
    truncated: false,
  },
  'page.snapshot': {
    url: 'https://www.google.com/',
    title: 'Google',
    token: 'muz34laa-ws7emahg',
    text: '页面正文内容',
    elements: [
      { index: 0, role: 'link', name: 'Gmail' },
      { index: 1, role: 'button', name: 'Google 应用', note: 'expanded=false' },
    ],
    truncated: false,
  },
  'page.waitFor': { found: true, note: '在 https://www.google.com/ 找到了 "今日热点"' },
  'page.query': {
    url: 'https://www.google.com/',
    title: 'Google',
    total: 3,
    truncated: false,
    items: [
      { index: 0, tag: 'a', text: 'Gmail', attributes: { href: 'https://mail.google.com/' } },
      { index: 1, tag: 'a', text: '图片', attributes: { href: 'https://www.google.com/imghp' } },
    ],
  },
  'page.hover': { note: '已悬停到 <button> 菜单' },
  'page.uploadBegin': { uploadId: 'up-1-1', note: '已开始接收 note.txt (5 字节)' },
  'page.uploadChunk': { received: 5, note: 'note.txt 已收到 5/5 字节' },
  'page.uploadCommit': { files: [{ name: 'note.txt', bytes: 5, mime: 'text/plain' }], note: '已装入 1 个文件' },
  'page.uploadAbort': { aborted: 1, note: '已丢弃 1 个未完成的上传' },
  'page.screenshot': {
    // 一个最小的 1x1 PNG, base64 已去掉 data URL 前缀.
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    format: 'png',
    width: 1512,
    height: 900,
    url: 'https://www.google.com/',
  },
  'page.evaluate': { value: '"Google"', truncated: false, valueType: 'string' },
}

/** 造一个只替换扩展层的假运行时; 其余字段照真实现填. */
function fakeRuntime(): BrowserRuntime {
  const resource: BrowserResource = {
    call: async <M extends BrowserMethod>(method: M) => EXTENSION_RESULTS[method] as never,
  }
  return {
    boundTabId: 1391393307,
    grantedId: 'agent-test',
    holdsBrowser: () => true,
    release: () => true,
    run: async (_agent, _signal, operation) => operation(resource),
    status: async () => ({
      chrome: { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', source: 'standard-path' },
      chromeError: null,
      profileDir: '/tmp/profile',
      dataDir: '/tmp/data',
      host: null,
      hostError: null,
      bridgeConnected: true,
      extensionVersion: '0.1.0',
      boundTabId: 1391393307,
      bridgeError: null,
      launchArgs: null,
      nextSteps: [],
    }),
  } as unknown as BrowserRuntime
}

/** 上传与截图要碰真实文件系统, 所以这两个用例需要临时目录. */
let tempRoot = ''

/** 一批临时文件, 供上传工具真读; 用例结束后清掉. */
let uploadFile = ''

/** 每个工具的调用参数; 覆盖全部 browser_* 工具. */
const CALL_ARGS: Record<string, unknown> = {
  browser_open: { justification: '验证浏览器平面' },
  browser_status: {},
  browser_tabs: {},
  browser_select_tab: { tabId: 1391393307 },
  browser_snapshot: {},
  browser_text: {},
  browser_click: { token: 'muz34laa-ws7emahg', index: 1 },
  browser_fill: { token: 'muz34laa-ws7emahg', index: 7, text: '今日热点', submit: true },
  browser_press_key: { key: 'Enter' },
  browser_scroll: { direction: 'down', amount: 850 },
  browser_navigate: { url: 'https://www.google.com/' },
  browser_wait: { text: '今日热点', timeoutMs: 5_000 },
  browser_query: { selector: 'a[href]', limit: 10 },
  browser_hover: { token: 'muz34laa-ws7emahg', index: 1 },
  browser_upload: { file_paths: [] as string[], selector: 'input[type=file]' },
  browser_screenshot: { format: 'png' },
  browser_evaluate: { expression: 'document.title', world: 'isolated' },
  browser_release: {},
}

/** 所有工具定义, 按名字索引. */
let tools: Map<string, ToolDefinition>

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-browser-contract-'))
  uploadFile = join(tempRoot, 'note.txt')
  await writeFile(uploadFile, 'hello', 'utf8')
  // 上传工具要读真实文件, 截图工具要写真实文件, 所以两者都指向临时目录.
  CALL_ARGS['browser_upload'] = { file_paths: [uploadFile], selector: 'input[type=file]' }

  const deps = { runtime: fakeRuntime() }
  const all = [
    ...sessionTools(deps),
    ...pageTools(deps),
    ...advancedTools(deps),
    screenshotTool({ ...deps, screenshotsDir: () => join(tempRoot, 'screenshots') }),
  ]
  tools = new Map(all.map(tool => [tool.name, tool]))
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

/**
 * 造一个最小的执行上下文.
 * @returns 工具执行上下文桩.
 */
function fakeExec(): never {
  return {
    agent: { id: 'agent-test' },
    signal: new AbortController().signal,
    callId: 'call-test',
    name: 'test',
    arguments: {},
  } as never
}

describe('每个 browser_* 工具的产物都是 harness 认可的 lossless JSON', () => {
  it('覆盖了全部已注册的工具 (新增工具时要一并纳入本测试)', () => {
    // 期望的工具名清单写死在这里: 新增工具而忘了给它加用例时, 这条会失败.
    expect([...tools.keys()].sort()).toEqual([
      'browser_click',
      'browser_evaluate',
      'browser_fill',
      'browser_hover',
      'browser_navigate',
      'browser_open',
      'browser_press_key',
      'browser_query',
      'browser_release',
      'browser_screenshot',
      'browser_scroll',
      'browser_select_tab',
      'browser_snapshot',
      'browser_status',
      'browser_tabs',
      'browser_text',
      'browser_upload',
      'browser_wait',
    ])
  })

  it.each(Object.keys(CALL_ARGS))('%s 的产物能通过 lossless-JSON 快照', async (name) => {
    const tool = tools.get(name)
    expect(tool, `找不到工具 ${name}`).toBeDefined()
    const value = await tool!.execute(CALL_ARGS[name], fakeExec())

    // 这就是生产路径上那道检查. 任何值为 undefined 的字段都会让它整体失败, 报
    // "value is not lossless JSON" —— 正是 browser_click 等四个工具曾经的症状.
    const snapshot = snapshotJsonValue(value)
    expect(snapshot, `${name} 的产物含 undefined 等非 JSON 值: ${JSON.stringify(value)}`).toBeDefined()
  })

  it.each(Object.keys(CALL_ARGS))('%s 的产物符合它自己声明的 output.schema', async (name) => {
    const tool = tools.get(name)!
    const value = await tool.execute(CALL_ARGS[name], fakeExec()) as Record<string, unknown>
    const schema = tool.output.schema as {
      properties?: Record<string, unknown>
      required?: readonly string[]
      additionalProperties?: boolean
    }
    const declared = Object.keys(schema.properties ?? {})

    // 产物不能带未声明的字段. `ok: undefined` 正是这样冒出来的: 声明里没有它就没人管,
    // 但它一旦存在 (值哪怕是 undefined) 就会破坏序列化.
    for (const key of Object.keys(value)) {
      expect(declared, `${name} 的产物多出未声明字段 "${key}"`).toContain(key)
    }
    // 声明为 required 的字段必须真的存在且不是 undefined.
    for (const key of schema.required ?? Object.keys(schema.properties ?? {})) {
      const entries = Object.entries(schema.properties ?? {})
      const field = entries.find(([k]) => k === key)?.[1] as { required?: boolean } | undefined
      if (field?.required !== true) continue
      expect(value[key], `${name} 声明 required 的 "${key}" 没出现在产物里`).toBeDefined()
    }
  })
})
