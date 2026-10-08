/**
 * 检查清单的状态映射.
 *
 * 从 `BrowserSettings.tsx` 里抽出来, 有两个原因.
 *
 * 一是**它原本只有"过/不过"两种状态**, 于是"还不确定"被硬塞进了其中一边. 具体闯的祸:
 * 浏览器求值那一行在扩展未连上时状态未知 (`userScriptsAvailable === null`), 而判断写成了
 * `ok: userScriptsAvailable !== false` —— `null` 于是落进"过"那一支, 整行显示**绿色**,
 * 旁边却诚实地写着"扩展未连上, 状态未知". 颜色和文字自相矛盾, 而绿色意味着"已确认可用",
 * 正是最容易让人误信的那种错.
 *
 * 二是抽出来之后才**测得动**. 这段映射原先内联在组件里, 于是没有任何测试覆盖: 界面里的一行
 * 颜色对不对, 只能靠人盯着看. 现在它是纯函数, 可以逐行断言.
 *
 * 四种状态的分工 (与界面组件的 `StateDot` 取值一一对应):
 *
 *   - `done`    已确认正常.
 *   - `warning` 需要处理, 但不算配置错误 (例如可选能力没开, 或用户需要打开自己的浏览器).
 *   - `error`   配置错了, 会挡住整条链路.
 *   - `idle`    **还看不出来** —— 不要用 `done` 表示这个.
 */

import { extensionLinkCounts, type StatusPayload } from '../../shared/status.js'
import type { BrowserSettingsKey } from './strings.js'

/** 一行检查项的状态. 取值与界面组件的 StateDot 一致. */
export type CheckState = 'done' | 'warning' | 'error' | 'idle'

/** 一行检查项的渲染数据. */
export interface CheckRow {
  /** 文案键, 同时也是这一行的身份. */
  key: BrowserSettingsKey
  state: CheckState
  /** 右侧说明; 越具体越有用, 因为它要告诉用户下一步做什么. */
  detail: string
}

/**
 * 把状态渲染成检查清单.
 *
 * @param status 宿主返回的状态.
 * @returns 检查项, 按"最该先看的排在前面"排列.
 */
export function checks(status: StatusPayload): CheckRow[] {
  return [
    {
      key: 'checkChrome',
      // 找不到 Chrome 就什么都做不了, 所以这是 error 而不是 warning.
      state: status.chromePath === null ? 'error' : 'done',
      detail: status.chromePath ?? status.chromeError ?? '',
    },
    {
      key: 'checkHost',
      // manifestStale 说明装过但内容与当前配置不符 (换了数据目录或换了密钥), 需要重装.
      // 它可修 (旁边的按钮就是干这个的), 所以是 warning; 完全没装才是 error.
      state: status.manifestStale ? 'warning' : (status.manifestReady ? 'done' : 'error'),
      detail: status.manifestStale ? '清单内容与当前配置不一致' : (status.manifestPath ?? ''),
    },
    {
      key: 'checkExtension',
      ...extensionRow(status),
    },
    {
      key: 'checkLaunch',
      // 这一项讲的是"用哪个浏览器", 本身没有对错: 允许 dsh 自己启动是一种用法, 只用用户
      // 现有的浏览器是另一种.
      state: status.launchStandaloneChromeProfile || status.bridgeConnected ? 'done' : 'warning',
      detail: status.launchStandaloneChromeProfile
        ? '会启动独立 profile 的 Chrome, 不复用日常窗口 (该 profile 需单独加载一次扩展)'
        : (status.bridgeConnected
          ? '只用你现有的浏览器 (扩展已连上), 不自行启动 Chrome'
          : '只用你现有的浏览器; 请打开装了扩展的那个 Chrome'),
    },
    {
      key: 'checkPairing',
      // 没配对令牌时整条链路都用不了, 所以是 error.
      state: status.pairingConfigured && status.pairingError === null ? 'done' : 'error',
      detail: status.pairingError !== null
        ? status.pairingError
        : (status.pairingConfigured
          ? '已配置; 扩展握手时会核对'
          : '尚未配置: 打开浏览器扩展的弹出面板, 复制其中的配对令牌, 粘贴到配置页的配对令牌输入框并保存'),
    },
    {
      key: 'checkEvaluate',
      ...evaluateRow(status),
    },
    {
      key: 'checkBinding',
      ...bindingRow(status),
    },
  ]
}

/**
 * 独立 profile 开关已开, 但本插件还没拉起那份窗口.
 *
 * 没拉起之前, 桥上那条连接属于日常 Chrome, 不能拿来给独立 profile 报绿灯.
 *
 * @param status 宿主状态.
 * @returns 还没拉起为 true.
 */
function standalonePending(status: StatusPayload): boolean {
  return status.launchStandaloneChromeProfile && !extensionLinkCounts(status) && status.launchArgs === null
}

/**
 * 扩展连接这一行.
 *
 * @param status 宿主状态.
 * @returns 状态与说明.
 */
function extensionRow(status: StatusPayload): { state: CheckState, detail: string } {
  if (standalonePending(status)) {
    return {
      state: 'idle',
      detail: status.bridgeConnected
        ? '当前连着的是日常 Chrome, 独立 profile 尚未启动 (不会复用)'
        : '第一次使用时会启动独立 profile; 请在那个窗口加载扩展',
    }
  }
  if (status.launchStandaloneChromeProfile && !status.bridgeConnected) {
    return {
      state: 'warning',
      detail: '独立 profile 已启动但扩展未连上, 请在那个窗口加载扩展',
    }
  }
  return {
    state: extensionLinkCounts(status) ? 'done' : 'warning',
    detail: status.extensionVersion === null ? '扩展尚未连上' : `扩展版本 ${status.extensionVersion}`,
  }
}

/**
 * 浏览器求值这一行.
 *
 * @param status 宿主状态.
 * @returns 状态与说明.
 */
function evaluateRow(status: StatusPayload): { state: CheckState, detail: string } {
  if (standalonePending(status)) {
    return { state: 'idle', detail: '独立 profile 尚未启动, 状态未知' }
  }
  if (status.userScriptsAvailable === null) {
    return { state: 'idle', detail: '扩展未连上, 状态未知' }
  }
  return {
    state: status.userScriptsAvailable ? 'done' : 'warning',
    detail: status.userScriptsAvailable
      ? 'browser_evaluate 可用'
      : '未启用; 在扩展详情页打开 Allow User Scripts 后 browser_evaluate 可用',
  }
}

/**
 * 绑定标签页这一行.
 *
 * @param status 宿主状态.
 * @returns 状态与说明.
 */
function bindingRow(status: StatusPayload): { state: CheckState, detail: string } {
  if (standalonePending(status)) {
    return { state: 'idle', detail: '独立 profile 尚未启动' }
  }
  if (status.boundTabId === null) {
    return { state: 'idle', detail: '尚未绑定标签页 (在会话里调用 browser_tabs 后选择)' }
  }
  return { state: 'done', detail: `id=${String(status.boundTabId)}` }
}
