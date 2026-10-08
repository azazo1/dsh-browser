/**
 * 扩展侧的错误类型.
 *
 * 单独一个模块, 而不是挂在 `page.ts` 上: 它要被多个模块使用 (标签页, 页面, 截图, 求值),
 * 而 `page.ts` 自己又依赖 `tabs.ts` —— 放在那里会让 `tabs.ts` 一导入它就成环.
 */

/** 一次浏览器操作失败, 带协议里的机器可读类别. */
export class PageError extends Error {
  /**
   * @param code 协议里的错误类别.
   * @param message 面向模型的中文说明.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PageError'
  }
}
