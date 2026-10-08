/**
 * 配对令牌.
 *
 * 扩展在首次运行时自己生成一个随机令牌, 存在 `chrome.storage.local` 里, 并在弹出面板上展示;
 * 用户把它抄进 dsh 的插件配置 (`pairingToken`). 握手时 dsh 核对这个令牌, 不一致就拒绝连接.
 *
 * 为什么由扩展生成而不是 dsh: 令牌要证明的是"连上来的是我认可的那个扩展", 而生成方能把它
 * 展示给人看, 人再抄进 dsh 那个受配置管理的一侧. 反过来做的话, dsh 生成了却没法直接告诉扩展
 * (两者之间唯一的通道就是要被授权的这条), 用户得从 dsh 界面抄到扩展里, 而扩展没有输入界面.
 *
 * 令牌存在扩展自己的存储里而不是文件里, 是为了让"谁持有这个秘密"尽量收窄: 本机其它进程读
 * 不到它 (除非去读 Chrome 的 profile 数据库).
 */

/** 存储键. */
const STORAGE_KEY = 'dshBrowserPairingToken'

/** 进程内缓存; service worker 每次唤醒都重新读一次存储太浪费. */
let cached: string | null = null

/** 正在进行的读取, 避免并发触发多次生成. */
let loading: Promise<string> | null = null

/**
 * 生成一个新的令牌.
 *
 * 32 字节随机数的 base64url 形式: 用 base64url 是因为它全部由 URL 安全的字符组成, 用户复制
 * 粘贴时不会被任何界面错误转义, 也不会在两侧的字符串比较里因为编码差异而不一致.
 *
 * @returns 新令牌.
 */
export function newPairingToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * 读取配对令牌, 首次运行时生成并保存.
 *
 * @returns 当前令牌.
 */
export async function pairingToken(): Promise<string> {
  if (cached !== null) return cached
  loading ??= (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY)
      const existing = stored[STORAGE_KEY]
      if (typeof existing === 'string' && existing !== '') {
        cached = existing
        return existing
      }
      const created = newPairingToken()
      await chrome.storage.local.set({ [STORAGE_KEY]: created })
      cached = created
      return created
    } finally {
      loading = null
    }
  })()
  return await loading
}

/**
 * 重新生成配对令牌.
 *
 * 令牌泄露或想重新配一次时用它; 生成之后 dsh 侧原来的配置立刻失效, 用户必须把新的那个抄过去.
 *
 * @returns 新令牌.
 */
export async function resetPairingToken(): Promise<string> {
  const created = newPairingToken()
  await chrome.storage.local.set({ [STORAGE_KEY]: created })
  cached = created
  return created
}
