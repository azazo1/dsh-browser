/**
 * 截图.
 *
 * 只截**当前视口**, 不做整页拼接: 整页要把页面滚动多次再拼起来, 而宿主侧没有任何图像
 * 库, 拼图就得引入图像依赖或者自己写 PNG 合成 —— 两条路都会给这个插件加上与"驱动浏览
 * 器"无关的负担. 视口截图已经覆盖绝大多数用途 (看当前状态, 确认某个元素长什么样), 需要
 * 整页时由调用方滚动后再截一次即可.
 *
 * 另一个限制来自 Chrome 本身: `captureVisibleTab` 截的是"窗口里当前可见的那一帧", 后台
 * 标签页根本不渲染. 所以这里要求目标标签页本来就已经是活动标签, 否则直接报错 ——
 * 本插件不会为了截图去切换标签页或聚焦窗口, 那属于会打断用户的动作.
 */

import { PageError } from './page.js'
import { getTab } from './tabs.js'
import type { ScreenshotResult } from '../../../shared/methods.js'

/** 截图支持的编码格式. */
export type ScreenshotFormat = 'png' | 'jpeg'

/** 视口尺寸. */
interface Viewport {
  width: number
  height: number
  url: string
}

/**
 * 读取视口尺寸.
 *
 * 用 `chrome.scripting` 而不是 `userScripts`: 视口尺寸不需要求值能力, 不该因此要求用户
 * 打开那个开关, 否则没开开关时连截图都做不了.
 *
 * @param tabId 目标标签页.
 * @returns 视口尺寸与地址.
 */
async function readViewport(tabId: number): Promise<Viewport> {
  const injected = chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (() => {
      return {
        width: Math.round(globalThis.innerWidth * (globalThis.devicePixelRatio || 1)),
        height: Math.round(globalThis.innerHeight * (globalThis.devicePixelRatio || 1)),
        url: globalThis.location.href,
      }
    }) as (...args: never[]) => unknown,
  }) as Promise<chrome.scripting.InjectionResult<unknown>[]>
  const first = (await injected)[0]
  const value = first?.result as Viewport | undefined
  if (value === undefined) {
    throw new PageError('injection-blocked', `无法读取 ${String(tabId)} 号标签页的视口尺寸, 该页面可能不允许脚本注入`)
  }
  return value
}

/**
 * 截取绑定标签页的当前视口.
 *
 * 这里**不再**把标签页切到前台或聚焦窗口. 代价是: `captureVisibleTab` 只截活动标签页
 * 已渲染的帧, 后台标签页拿不到画面, 所以只在这个标签页本来就已经是活动标签时才截,
 * 否则直接报错让调用方自己决定要不要请用户让出前台.
 *
 * 宁可报错也不切前台: 切一下就会把用户正在看的东西顶掉, 而截图本身是只读动作, 为它
 * 抢走用户的注意力不划算.
 *
 * @param tabId 目标标签页.
 * @param format 编码格式.
 * @returns 截图的字节与尺寸.
 */
export async function captureTab(tabId: number, format: ScreenshotFormat): Promise<ScreenshotResult> {
  const tab = await getTab(tabId)
  const windowId = tab.windowId

  if (!tab.active) {
    throw new PageError(
      'screenshot-needs-foreground',
      `标签页 ${tabId} 当前不是活动标签页, 拿不到它的可见画面. `
      + '本插件不会为了截图把浏览器切到前台 (那会打断 user 正在做的事), '
      + '请在 Chrome 里手动切到这个标签页, 或者改用 browser_snapshot / browser_evaluate 读取内容.',
    )
  }

  const viewport = await readViewport(tabId)

  let dataUrl: string
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new PageError(
      'screenshot-failed',
      `截图失败: ${message}. 常见原因: 目标标签页不是当前可见的那一个, 窗口被最小化, `
      + '或者 Chrome 的内部页面不允许截图; 也可能触发了 Chrome 的截图频率限制 (每秒两次), 稍后重试即可',
    )
  }

  const prefix = `data:image/${format};base64,`
  if (!dataUrl.startsWith(prefix)) {
    // 前缀对不上说明拿到的不是预期的图片数据, 与其猜不如直接报出来.
    throw new PageError('screenshot-failed', `截图返回的数据不是预期的 ${format} data URL, 实际开头是 ${dataUrl.slice(0, 40)}`)
  }

  return {
    data: dataUrl.slice(prefix.length),
    format,
    width: viewport.width,
    height: viewport.height,
    url: viewport.url,
  }
}
