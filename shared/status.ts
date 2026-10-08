/**
 * 配置页与 Host 接口之间共享的状态形状.
 *
 * 放在 shared/ 而不是各自定义两份: 这个结构是两侧的对接口径, 字段一改名就会导致
 * 界面静默显示空值, 让两侧从同一份声明出发可以避免这类漂移.
 */

/** 连接组件与浏览器的综合状态. */
export interface StatusPayload {
  /** Chrome 可执行文件路径; 未找到为 null. */
  chromePath: string | null
  /** 该路径的来源: configured / standard-path / PATH. */
  chromeSource: string | null
  /** 未找到 Chrome 时的原因说明. */
  chromeError: string | null
  /** 持久 profile 目录. */
  profileDir: string
  /** 插件数据根目录. */
  dataDir: string
  /** 由扩展公钥派生的扩展 id. */
  extensionId: string | null
  /** 扩展产物目录; 用户要在 chrome://extensions 里选中它. */
  extensionDir: string
  /** native messaging 清单路径. */
  manifestPath: string | null
  /** 清单与包装脚本是否都已就位. */
  manifestReady: boolean
  /** 清单存在但内容不符, 需要重装. */
  manifestStale: boolean
  /** 包装脚本里写死的解释器路径. */
  interpreter: string
  /** 扩展是否已连上宿主. */
  bridgeConnected: boolean
  /**
   * 当前这条连接所属 Chrome 的 `--user-data-dir`; 探测不到为 null.
   *
   * 独立 profile 开着时, 只有它和 `profileDir` 一致才算连上了选中的那个浏览器.
   */
  peerUserDataDir: string | null
  /** 扩展清单版本. */
  extensionVersion: string | null
  /** 扩展当前绑定的标签页 id. */
  boundTabId: number | null
  /**
   * 浏览器求值 (browser_evaluate) 是否可用.
   *
   * 取决于用户在扩展详情页手动打开的 "Allow User Scripts" 开关; null 表示扩展没连上,
   * 状态未知而不是不支持.
   */
  userScriptsAvailable: boolean | null
  /** 桥层的最近一次异常. */
  bridgeError: string | null
  /** 是否允许 dsh 启动它自己那份独立 profile 的 Chrome. */
  launchStandaloneChromeProfile: boolean
  /** 当前持有浏览器驱动权的会话 id; 无人为 null. */
  holderId: string | null
  /** dsh 侧是否已经配置了配对令牌. */
  pairingConfigured: boolean
  /** 握手因配对失败被拒时的原因; null 表示没有发生过. */
  pairingError: string | null
  /** 本次运行使用的 Chrome 启动参数. */
  launchArgs: string[] | null
  /** 仍需完成的步骤. */
  manualSteps: string[]
  /** 综合判断: 现在能否直接操作页面. */
  ready: boolean
}

/**
 * 比较两个 user-data-dir 是否指向同一份 profile.
 *
 * @param left 一侧路径.
 * @param right 另一侧路径.
 * @returns 视为同一目录为 true.
 */
export function sameUserDataDir(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return normalize(left) === normalize(right)
}

/**
 * 当前桥连接是否就是本插件选中的那个浏览器.
 *
 * 独立 profile 开着时: 优先看对端报上来的 user-data-dir 是否就是配置里那份;
 * 探测不到才退回 "本进程是否拉起过" (launchArgs), 避免把日常 Chrome 当成就绪.
 *
 * @param status 与判定有关的字段.
 * @returns 选中的那个浏览器已经连上为 true.
 */
export function extensionLinkCounts(status: {
  launchStandaloneChromeProfile: boolean
  bridgeConnected: boolean
  launchArgs: string[] | null
  profileDir: string
  peerUserDataDir?: string | null
}): boolean {
  if (!status.launchStandaloneChromeProfile) return status.bridgeConnected
  if (!status.bridgeConnected) return false
  const peer = status.peerUserDataDir
  if (typeof peer === 'string' && peer !== '') return sameUserDataDir(peer, status.profileDir)
  return status.launchArgs !== null
}

/** 接口失败时返回的形状. */
export interface ErrorPayload {
  error: string
}
