/**
 * 截图工具.
 *
 * 图片**只落成文件, 不内联给模型**. 这不是偷懒, 而是刻意的分工:
 *
 *   - harness 自带的 read_image 已经完整实现了"把图片交给模型"这条链 —— 模型是否声明图片
 *     输入, 字节与像素限额, 超限自动缩放, 以及写入 attachment 存储. 本插件再实现一遍,
 *     等于把同一件事维护在两个地方, 而这类"两侧由一份约定连接, 实现却各自漂移"的问题今天
 *     已经撞到两次 (工具产物多出 `ok` 字段, 注入参数里混进 `undefined`), 没有理由再造一处.
 *   - 落成文件之后, 无论当前模型能不能看图都有用: 能看就 read_image 读它, 不能看就把路径给
 *     user, 他在 GUI 里直接能看到.
 *
 * 所以本工具负责的只是"把浏览器当前视口变成磁盘上的一个 PNG", 剩下的交给已有设施.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { formatScreenshot } from './format.js'
import { runBrowser } from './shared.js'
import type { ToolDeps } from './shared.js'

/**
 * 构建截图工具.
 *
 * @param deps 工具依赖, 额外需要截图目录的来源.
 * @returns 工具定义.
 */
export function screenshotTool(deps: ToolDeps & { screenshotsDir: () => string }): ToolDefinition {
  return defineTool({
    name: 'browser_screenshot',
    description:
      '截取当前绑定标签页的**可见视口**并存成一个图片文件, 返回它的路径. '
      + '只截视口: 截图不能超过一屏, 需要看下面内容时先 browser_scroll 再截. '
      + '本工具不把图片直接交给模型, 所以拿到路径后: 若你能看图, 用 read_image 读这个路径; '
      + '若不能, 把路径告诉 user 由他查看. '
      + '截图前会把这个标签页激活到前台, 这是 Chrome 的截图接口的要求 (它截的是当前可见的那一帧).',
    parameters: {
      format: { type: 'string', description: '图片格式, "png" (默认) 或 "jpeg" (更小)' },
    },
    presentCall: () => ({ card: 'generic', title: '截取页面视口' }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'PNG 或 JPEG 文件的绝对路径' },
          bytes: { type: 'integer', required: true, description: '文件字节数' },
          width: { type: 'integer', required: true, description: '图片像素宽' },
          height: { type: 'integer', required: true, description: '图片像素高' },
          url: { type: 'string', required: true, description: '被截页面的地址' },
          text: { type: 'string', required: true, description: '给模型的完整说明' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args, exec) => runBrowser(deps, exec, async (resource) => {
      const format = args.format === 'jpeg' ? 'jpeg' : 'png'
      const shot = await resource.call('page.screenshot', { format }, exec.signal)

      const dir = deps.screenshotsDir()
      await mkdir(dir, { recursive: true })
      // 文件名带毫秒时间戳, 连拍时不会互相覆盖; 同时保留可读的日期部分便于人工翻找.
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      const path = join(dir, `shot-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`)
      const bytes = Buffer.from(shot.data, 'base64')
      await writeFile(path, bytes)

      return {
        path,
        bytes: bytes.length,
        width: shot.width,
        height: shot.height,
        url: shot.url,
        text: formatScreenshot({ path, bytes: bytes.length, width: shot.width, height: shot.height, url: shot.url }),
      }
    }),
  })
}
