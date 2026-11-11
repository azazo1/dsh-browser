/**
 * 配置页接口路由必须跟着插件生命周期一起消失.
 *
 * webserver 的注册表是宿主级单例, 路由只在 disposer 被调用时才从表里删除. 插件
 * 重载 (改配置, 插件管理器更新) 会销毁旧 ctx 再重新 apply, 所以注册必须放进
 * `ctx.effect`. 否则旧路由留在表里, 第二次写入同一个前缀就抛
 * `duplicate prefix route` 而整体加载失败 —— 现象是浏览器工具直接从会话里消失.
 *
 * 这里不启动真实 HTTP 监听, 只用 WebServer 的路由表当探针.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { BrowserRuntime } from '../src/runtime.ts'
import type { PairingTokenStore } from '../src/pairing-store.ts'
import type { PairingDrain } from '../src/pairing-sync.ts'
import { API_PREFIX, registerApi } from '../src/server.ts'

/** 只用来占位: 测试只关心注册表, 不会真的走请求处理. */
const unused = {} as never

/** 以真实插件形态挂载接口: 声明 webServer 依赖, 否则 apply 里取服务会抛错. */
const mountApi = {
  name: 'test-mount-api',
  inject: ['webServer'],
  apply: (ctx: Context): void => {
    registerApi(ctx, unused as BrowserRuntime, unused as PairingTokenStore, unused as PairingDrain)
  },
}

/**
 * 等 fiber 跑完异步启动.
 * @param ctx 刚创建的 fiber 上下文.
 * @returns 启动结束.
 */
async function settle(ctx: { inertia?: Promise<void> }): Promise<void> {
  await ctx.inertia
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('配置页接口路由的生命周期', () => {
  it('插件卸载后路由随之移除, 重新加载不会撞前缀', async () => {
    const root = new Context()
    // 直接构造服务即可, 不调用它的启动流程, 因此不会占用真实端口.
    new WebServer(root, { host: '127.0.0.1', port: 0 })

    const first = root.plugin(mountApi as never)
    await settle(first)
    await first.dispose()

    // 旧路由若没被清理, 这一句就会抛 duplicate prefix route.
    expect(() => {
      root.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: () => undefined })
    }).not.toThrow()
  })
})
