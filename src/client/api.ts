/**
 * 配置页的状态来源.
 *
 * 数据取自 Host 的同源接口 `/dsh-browser/api/status` (见 src/server.ts). 走 HTTP 而
 * 不是 ctx.configForms, 原因是这里展示的不是配置值, 而是**运行时的就绪状态**:
 * Chrome 有没有找到, 连接组件装没装, 扩展连上没有, 以及扩展产物落在哪个目录.
 * 这些都不是 profile 里的配置项, 放在表单里也不合适.
 *
 * 所有写操作 (安装 / 卸载连接组件, 以及会话 Tab 上的获取 / 释放) 也走同一组接口,
 * 由 Host 侧执行并重新回报状态, 因此页面上看到的状态始终是 Host 的真实观测,
 * 不是前端的乐观猜测.
 */

import type { StatusPayload } from '../../shared/status.js'

/** 接口根路径; 与 Host 侧 API_PREFIX 必须一致. */
const API = '/dsh-browser/api'

/** 带上同源 cookie 请求一个接口. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    // 同源请求需要带上 dsh 的登录令牌 cookie, 否则会被 Host 的鉴权挡下.
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(`接口 ${path} 返回了非 JSON 内容 (HTTP ${String(response.status)}): ${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    const message = (parsed as { error?: unknown }).error
    throw new Error(typeof message === 'string' ? message : `接口 ${path} 失败, HTTP ${String(response.status)}`)
  }
  return parsed as T
}

/** 读一次状态. */
export async function fetchStatus(): Promise<StatusPayload> {
  return request<StatusPayload>('/status')
}

/** 安装连接组件 (扩展产物 + native messaging 清单), 返回安装后的状态. */
export async function installHost(): Promise<StatusPayload> {
  return request<StatusPayload>('/install', { method: 'POST', body: '{}' })
}

/** 卸载连接组件, 返回卸载后的状态. */
export async function uninstallHost(): Promise<StatusPayload> {
  return request<StatusPayload>('/uninstall', { method: 'POST', body: '{}' })
}

/**
 * 把浏览器驱动权交给指定会话. 这是用户本人在会话 Tab 里点的, 不再弹审批.
 *
 * @param sessionId 当前会话 id.
 * @returns 授予后的状态.
 */
export async function acquireBrowser(sessionId: string): Promise<StatusPayload> {
  return request<StatusPayload>('/acquire', { method: 'POST', body: JSON.stringify({ sessionId }) })
}

/**
 * 若本会话持有驱动权则释放.
 *
 * @param sessionId 当前会话 id.
 * @returns 释放后的状态.
 */
export async function releaseBrowser(sessionId: string): Promise<StatusPayload> {
  return request<StatusPayload>('/release', { method: 'POST', body: JSON.stringify({ sessionId }) })
}
