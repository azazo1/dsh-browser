/**
 * 截图.
 *
 * 只截**当前视口**, 不做整页拼接: 整页要把页面滚动多次再拼起来, 而宿主侧没有任何图像
 * 库, 拼图就得引入图像依赖或者自己写 PNG 合成 —— 两条路都会给这个插件加上与"驱动浏览
 * 器"无关的负担. 视口截图已经覆盖绝大多数用途 (看当前状态, 确认某个元素长什么样), 需要
 * 整页时由调用方滚动后再截一次即可.
 *
 * 另一个限制来自 Chrome 本身: `captureVisibleTab` 截的是"某个窗口里当前可见的那一帧",
 * 所以必须先把这个标签页激活并把窗口提到前台, 否则截到的是别的东西. 这不是可以绕过的
 * 实现细节, 而是这个 API 的语义.
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
 * @param tabId 目标标签页.
 * @param format 编码格式.
 * @returns 截图的字节与尺寸.
 */
export async function captureTab(tabId: number, format: ScreenshotFormat): Promise<ScreenshotResult> {
  const tab = await getTab(tabId)
  const windowId = tab.windowId

  // 必须先把目标标签页放到前台: captureVisibleTab 截的是窗口里可见的那一帧, 后台标签页
  // 截出来会是别的页面的内容, 或者直接失败.
  await chrome.tabs.update(tabId, { active: true })
  if (typeof windowId === 'number') {
    // 窗口本身也要提到前台, 被其它窗口盖住时同样拿不到有效画面.
    await chrome.windows.update(windowId, { focused: true }).catch(() => undefined)
  }

  // 激活之后等一拍再截, 否则可能截到切换前的旧帧.
  await new Promise<void>((resolve) => { setTimeout(resolve, 150) })

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
