/**
 * 工具栏弹窗: 显示连接状态和引导信息.
 *
 * 有意用原生 DOM 而不是引入框架: 这个界面只有几行状态加一个按钮, 引入 React
 * 会让扩展多一个构建面和几十 KB 体积, 收益为零.
 */

/** 与 service worker 约定的状态响应形状. */
interface StatusResponse {
  /** 与 native host 的 stdio 通道是否建立. */
  hostConnected: boolean
  /** host 是否已确认连上 dsh. */
  linked: boolean
  lastError: string | null
  attempts: number
  boundTabId: number | null
  hostName: string
  /** 浏览器求值所需的 "Allow User Scripts" 开关是否已打开. */
  userScripts: boolean
}

/** 取一个元素, 找不到就抛错 (弹窗 DOM 是静态的, 缺元素属于开发错误). */
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`popup 缺少元素 #${id}`)
  return found as T
}

/**
 * 按状态刷新界面.
 *
 * 三态而不是两态, 因为"连上了本地组件"和"打通到 dsh"是两件事: 前者扩展自己就知道,
 * 后者只有 host 能确认. 混在一起显示会出现"已连接但 dsh 里什么都没有"的误导, 让人
 * 完全不知道下一步该修哪里.
 */
function render(status: StatusResponse): void {
  const dot = element('dot')
  const headline = element('headline')
  const detail = element('detail')
  const binding = element('binding')
  const capabilities = element('capabilities')

  if (status.linked) {
    dot.className = 'dot ok'
    headline.textContent = '已连接到 dsh'
    detail.textContent = `通道: native messaging (${status.hostName})`
  } else if (status.hostConnected) {
    // host 起来了但还没连上 dsh: 多半是 dsh 没运行, 或者会合文件还没写出来.
    dot.className = 'dot warn'
    headline.textContent = '已连上本地组件, 但 dsh 未就绪'
    detail.textContent = 'native host 正在重试连接 dsh. 请确认 dsh 正在运行, 并在插件配置页点一下"安装连接组件".'
  } else {
    dot.className = 'dot bad'
    headline.textContent = '未连接'
    detail.textContent = status.lastError ?? '正在建立连接...'
  }

  binding.textContent = status.boundTabId === null
    ? '尚未绑定标签页'
    : `已绑定标签页 #${status.boundTabId}`

  // 求值能力取决于一个手动开关, 打开前工具会拒绝调用, 所以这里直接说明状态.
  capabilities.textContent = status.userScripts
    ? '浏览器求值: 可用'
    : '浏览器求值: 未启用 (在扩展详情页打开 Allow User Scripts)'
}

/** 向 service worker 要一次状态. */
async function refresh(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ kind: 'status' }) as StatusResponse
    render(status)
  } catch (error) {
    render({
      hostConnected: false,
      linked: false,
      lastError: `无法询问后台: ${String(error)}`,
      attempts: 0,
      boundTabId: null,
      hostName: 'unknown',
      userScripts: false,
    })
  }
}

element('reconnect').addEventListener('click', () => {
  void chrome.runtime.sendMessage({ kind: 'reconnect' }).then(() => { void refresh() })
})

void refresh()
// service worker 的重连是异步的, 弹窗开着的时候每秒跟一次状态.
setInterval(() => { void refresh() }, 1_000)
