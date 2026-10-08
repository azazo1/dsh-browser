/**
 * 面向 Web 客户端 (插件配置页) 的同源 HTTP 接口.
 *
 * 走 HTTP 而不是 dsh 的 client-host RPC 通道, 理由是这里只需要"读一个状态"和"触发
 * 一次安装动作", 而 HTTP 路由是本插件已经要注册的能力 (桥的升级路由), 复用同一套
 * 鉴权即可, 不必再引入一套 wire contract.
 *
 * 鉴权交给 `connection` 服务的 `requestRejection`: 它同时挡住 DNS rebinding 和
 * 跨站请求 (403), 并要求浏览器侧的登录令牌 (401). 因此配置页的 fetch 天然带 cookie
 * 就能通过, 而别的页面即使猜到端口也过不了.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type { StatusPayload } from '../shared/status.js'
import { grantFromUserClick } from './acquire.js'
import type { BrowserRuntime } from './runtime.js'
import { evaluateSetup, hostParts } from './setup.js'
import { uninstallHost } from './native-host/install.js'

/** 本插件 HTTP 接口的前缀. */
export const API_PREFIX = '/dsh-browser/api'

/** 请求体上限: 这些接口只收空对象或一个 sessionId, 给足余量即可. */
const MAX_BODY_BYTES = 8 * 1024

/** 会话 id 白名单, 与 dsh-plugin-chrome 同一条规则. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u

/** dsh 的 connection 服务里我们用到的那一点. */
interface ConnectionGuard {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** 发一个 JSON 响应. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

/** 读完请求体 (安装 / 卸载只需要确认它不太大). */
async function drainBody(req: IncomingMessage): Promise<void> {
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
  }
}

/** 读一个有界 JSON 对象. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/**
 * 从请求体取出会话 id.
 *
 * @param body JSON 对象.
 * @returns 合法的会话 id.
 */
function sessionIdOf(body: Record<string, unknown>): string {
  const sessionId = body['sessionId']
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new Error('sessionId 不合法')
  }
  return sessionId
}

/** 把运行时的状态整理成配置页需要的形状. */
async function collect(runtime: BrowserRuntime): Promise<StatusPayload> {
  const status = await runtime.status()
  const host = status.host
  return {
    chromePath: status.chrome?.path ?? null,
    chromeSource: status.chrome?.source ?? null,
    chromeError: status.chromeError,
    profileDir: status.profileDir,
    dataDir: status.dataDir,
    extensionId: host?.extensionId ?? null,
    extensionDir: host?.extensionDir ?? runtime.paths.extensionDir,
    manifestPath: host?.manifestPath ?? null,
    manifestReady: host?.manifestReady === true,
    manifestStale: host?.manifestStale === true,
    interpreter: host?.interpreter ?? '',
    bridgeConnected: status.bridgeConnected,
    extensionVersion: status.extensionVersion,
    userScriptsAvailable: status.userScriptsAvailable,
    boundTabId: status.boundTabId,
    bridgeError: status.bridgeError,
    launchStandaloneChromeProfile: status.launchStandaloneChromeProfile,
    holderId: status.holderId,
    pairingConfigured: status.pairingConfigured,
    pairingError: status.pairingError,
    launchArgs: status.launchArgs,
    peerUserDataDir: status.peerUserDataDir,
    manualSteps: status.nextSteps,
    // 跟 setup 同一条路: 独立 profile 开着时不要求此刻已经有扩展连着 (那可能是日常 Chrome).
    ready: status.chrome !== null && evaluateSetup({
      ...hostParts(status.host, runtime.paths),
      pairingConfigured: status.pairingConfigured,
      pairingError: status.pairingError,
      bridgeConnected: status.bridgeConnected,
      launchStandaloneChromeProfile: status.launchStandaloneChromeProfile,
    }).ready,
  }
}

/**
 * 注册配置页接口.
 *
 * `webServer` 来自插件的必需 `inject`, 可直接取用. `connection` 则是可选的: 纯 CLI /
 * headless 组合里没有它, 这时返回 503 而不是把整个插件拖成必需依赖.
 *
 * @param ctx 插件上下文.
 * @param runtime 浏览器运行时.
 */
export function registerApi(ctx: Context, runtime: BrowserRuntime): void {
  const webServer = ctx.webServer
  webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const connection = ctx.get('connection') as ConnectionGuard | undefined
      if (connection === undefined) {
        sendJson(res, 503, { error: 'dsh 的 connection 服务不可用, 无法校验请求来源' })
        return
      }
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { error: rejection === 401 ? '请求未通过 dsh 认证 (浏览器侧缺少登录令牌)' : '请求未通过 Host/Origin 校验' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      try {
        if (req.method === 'GET' && path === `${API_PREFIX}/status`) {
          sendJson(res, 200, await collect(runtime))
          return
        }
      if (req.method === 'POST' && path === `${API_PREFIX}/install`) {
        await drainBody(req)
        const installed = await runtime.install()
        ctx.logger.info(`dsh-browser: 连接组件已安装, 扩展 id=${installed.extensionId}`)
        sendJson(res, 200, await collect(runtime))
        return
      }
      if (req.method === 'POST' && path === `${API_PREFIX}/uninstall`) {
        await drainBody(req)
        await uninstallHost(runtime.paths)
        ctx.logger.info('dsh-browser: 连接组件已卸载')
        sendJson(res, 200, await collect(runtime))
        return
      }
      if (req.method === 'POST' && path === `${API_PREFIX}/acquire`) {
        const sessionId = sessionIdOf(await readJsonBody(req))
        const agent = ctx.agents.get(sessionId as Agent['id'])
        if (agent === undefined) {
          sendJson(res, 404, { error: '这个会话没有活着的 agent, 无法授予驱动权' })
          return
        }
        const decision = grantFromUserClick({
          runtime,
          agent,
          setup: await runtime.setup(),
        })
        if (decision.kind === 'deny') {
          sendJson(res, 409, { error: decision.reason })
          return
        }
        ctx.logger.info(`dsh-browser: 用户在会话 Tab 把驱动权交给 ${agent.id}`)
        sendJson(res, 200, await collect(runtime))
        return
      }
      if (req.method === 'POST' && path === `${API_PREFIX}/release`) {
        const sessionId = sessionIdOf(await readJsonBody(req))
        const agent = ctx.agents.get(sessionId as Agent['id'])
        if (agent === undefined) {
          sendJson(res, 404, { error: '这个会话没有活着的 agent, 无法释放驱动权' })
          return
        }
        const released = runtime.release(agent)
        ctx.logger.info(`dsh-browser: 用户在会话 Tab ${released ? '释放了' : '尝试释放'} ${agent.id} 的驱动权`)
        sendJson(res, 200, await collect(runtime))
        return
      }
      sendJson(res, 404, { error: `未知接口 ${req.method ?? ''} ${path}` })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error(`dsh-browser: 接口 ${path} 失败: ${message}`)
        sendJson(res, 500, { error: message })
      }
    },
  })
}
