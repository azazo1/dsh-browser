/**
 * 配对令牌的本机存放.
 *
 * 令牌是 "这台设备上的这份扩展" 的身份凭据, 每台机器各不相同; 而 dsh 的配置文件常常
 * 被用户整个纳入 git 在多台设备间同步. 把令牌放进配置, 它就会跟着同步走: 在另一台设备
 * 上对不上号, 还平白多泄一份. 因此配置里的 pairingToken 字段只是**入口**: 插件读到非空
 * 值就立刻把它转移到数据目录下的令牌文件 (0600), 并把配置字段清空 —— 配置文件里不留令牌.
 *
 * 数据目录默认是 `<DSH_HOME>/data/dsh-browser`, 天然按机器隔离.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 令牌在数据目录里的文件名. */
const TOKEN_FILE = 'pairing-token'

/**
 * 已配对令牌的单一来源.
 *
 * 握手核对是同步代码路径, 所以这里用同步 IO + 内存缓存: 令牌文件只有几十字节,
 * 读取成本可以忽略. 缓存的更新时机是构造, `store()` 与 `reload()`.
 */
export class PairingTokenStore {
  private cached: string

  /**
   * @param dataDir 插件数据目录的取值口; 每次取, 保证配置改动立即生效.
   */
  constructor(private readonly dataDir: () => string) {
    this.cached = this.readFromDisk()
  }

  /** 令牌文件路径. */
  get path(): string {
    return join(this.dataDir(), TOKEN_FILE)
  }

  /** 当前生效的令牌; 还没有已配对令牌时为空串. */
  current(): string {
    return this.cached
  }

  /** 重新从磁盘读取; 用户手动改过令牌文件之后靠它跟上. */
  reload(): void {
    this.cached = this.readFromDisk()
  }

  /**
   * 覆盖保存令牌.
   * @param token 新令牌.
   */
  store(token: string): void {
    mkdirSync(this.dataDir(), { recursive: true })
    writeFileSync(this.path, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    this.cached = token
  }

  /**
   * 从磁盘读令牌文件.
   * @returns 文件内容 (去掉首尾空白); 文件不存在时为空串, 其他错误照常抛出.
   */
  private readFromDisk(): string {
    try {
      return readFileSync(this.path, 'utf8').trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }
}
