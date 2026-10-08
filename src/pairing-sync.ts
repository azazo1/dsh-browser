/**
 * 配置字段与令牌文件之间的单向清理 (配置 -> 文件).
 *
 * 新的令牌写入路径是配置页直接调 HTTP 接口落文件 (见 server.ts 的 /pairing-token),
 * 配置 patch 从头到尾不经过令牌. 这个模块只处理**遗留**在配置字段里的东西: 老版本
 * 存过的令牌, 或上一版清理方式写下的空串 —— 只要配置里还有这个键就把它整个删掉;
 * 值非空时先搬进令牌文件再删.
 *
 * 时序约束: 删键走 configEditor, 而 configEditor 的编辑必须在 HMR 事务**之外**
 * 发起 —— 从 loader/volatile-update 的调用栈里同步发起时, 仍处于外层保存事务的
 * AsyncLocalStorage 上下文里, hmr.runExclusive 会以 "HMR transactions cannot be
 * nested" 直接拒绝. 因此清理只放在两类干净上下文里: 插件启动, 以及配置页的 HTTP
 * 请求; volatile-update 里只刷新文件缓存, 不动配置.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PairingTokenStore } from './pairing-store.js'
import type { Config as ConfigShape } from './config.js'

/** 配置字段遗留令牌的清理器. */
export interface PairingDrain {
  /**
   * 配置里还有 pairingToken 键时把它删掉; 值非空时先搬进令牌文件.
   *
   * @returns 配置里是否存在过这个键 (含删键失败的情况).
   */
  drain(): Promise<boolean>
  /** drain 的容错版: 失败只记日志, 不向调用方抛出. */
  drainSafely(): void
}

/**
 * 建立配置字段遗留令牌的清理器.
 *
 * @param ctx 插件上下文.
 * @param input 插件配置.
 * @param pairing 已配对令牌的存放.
 * @returns 清理器.
 */
export function createPairingDrain(ctx: Context, input: ConfigShape, pairing: PairingTokenStore): PairingDrain {
  const drain = async (): Promise<boolean> => {
    // 只要配置里还有这个键就值得清一次: 既处理老版本留下的真实令牌, 也处理上一版
    // 清理方式写下的空串残留. 键不存在时直接返回, 轮询路径上零成本.
    const entry = ctx.fiber?.entry
    const raw = entry?.options.config as Record<string, unknown> | undefined
    if (raw === undefined || !Object.hasOwn(raw, 'pairingToken')) return false
    const token = input.pairingToken.get()
    if (token !== '') {
      pairing.store(token)
      ctx.logger.info('dsh-browser: 配置里遗留的配对令牌已转移到本机数据目录, 配置文件里不再保留')
    }
    const editor = ctx.get('configEditor')
    if (editor === undefined) {
      ctx.logger.warn('dsh-browser: 无法清空配置里遗留的配对令牌 (取不到 configEditor 服务), 它会暂时留在配置文件里')
      return true
    }
    // 把键整个删掉而不是写成空串: 空串虽然无害, 但会作为一行噪音留在会被同步的
    // patch 里. 删掉后如果条目没有其他配置, 整行都会从 patch 里消失.
    await editor.edit(entry!, (current) => {
      const next = { ...current }
      Reflect.deleteProperty(next, 'pairingToken')
      return next
    })
    return true
  }

  return {
    drain,
    drainSafely: () => {
      void drain().catch((error: unknown) => {
        ctx.logger.warn(
          `dsh-browser: 清理配置里遗留的配对令牌失败: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    },
  }
}

