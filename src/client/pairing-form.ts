/**
 * 插件配置卡片上的编辑表单 (独立 profile 与自动安装开关).
 *
 * 为什么必须自己接这一层: `plugins.bundle.config` 槽**不会**拿到框架给的 `form` 助手 ——
 * 对比一下就清楚, `plugins.item` 与 `plugins.row.config` 的 owner props 里都有 `form`, 而
 * bundle 那一处只传了 `{ view: 'page' }`. 也就是说: 除非插件自己把配置表单渲染出来, 否则
 * 卡片上**根本没有任何地方能填配置**.
 *
 * 写法照官方最小示例 (`ui-settings-shell`): 用 `ctx.configForms.get(条目 id)` 拿共享表单,
 * 用 `SettingsFormModel` 暂存草稿, 保存时才写回. 保存是唯一的写入口 —— 边打字边写会让一次
 * 编辑变成多次用户没有要求也无法预览的写入.
 *
 * 配对令牌不在其中: 它不进配置 patch, 由配置页的令牌输入区直接提交到 Host 的 HTTP
 * 接口落数据目录文件.
 */

import { SettingsFormModel } from '@deepseek-ai/dsh-client-ui-primitives'
import { ENTRY_ID } from './entry.js'
import type {
  SettingsFieldSpec,
  SettingsFieldState,
  SettingsFormActions,
  SettingsFormScope,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

export { ENTRY_ID } from './entry.js'

/** 本页编辑的配置字段. */
export interface PairingSettings {
  /** 是否让 dsh 启动一份独立 profile 的 Chrome. */
  launchStandaloneChromeProfile?: boolean
  /** 是否在插件加载与会话取资源前自动同步扩展产物与连接组件. */
  installHostAutomatically?: boolean
}

/**
 * 布尔字段的暂存规格.
 *
 * 官方字段控件只有文本 / 数字 / 密文, 开关要自绘, 但仍走同一套草稿模型, 保存时才写入.
 *
 * @param field 字段名.
 * @returns 字段规格.
 */
function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === true ? 'true' : 'false'),
    parse: (text) => {
      if (text === 'true') return { kind: 'set', value: true }
      if (text === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/** 卡片渲染需要的状态. */
export interface PairingCardState extends SettingsFormShell {
  /** 独立 profile 开关的暂存状态. */
  launchStandaloneChromeProfile: SettingsFieldState
  /** 自动安装开关的暂存状态. */
  installHostAutomatically: SettingsFieldState
}

/** 槽位注册时注入的对外面. */
export interface PairingCardFace extends SettingsFormActions {
  hooks: {
    /** 卡片通过它读表单状态; 渲染器会绑成 usePairingForm. */
    pairingForm: SnapshotStore<PairingCardState>
  }
}

/** 把配对令牌那一份表单桥接到卡片上. */
export class PairingFormController {
  private readonly form: SettingsFormModel<PairingSettings>
  private readonly store: SnapshotStore<PairingCardState>

  /**
   * @param scope 条目 id 对应的共享配置表单.
   */
  constructor(scope: SettingsFormScope<PairingSettings>) {
    // 配对令牌刻意不在这份表单里: 令牌按设备各一份, 而配置文件常被 git 同步, 所以它
    // 的写入走配置页自己的 HTTP 接口直接落数据目录文件, 不进配置 patch (见 BrowserSettings
    // 的令牌输入区). 这里只剩两个真正的配置开关.
    this.form = new SettingsFormModel(scope, [
      settingsBooleanField('launchStandaloneChromeProfile'),
      settingsBooleanField('installHostAutomatically'),
    ])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      launchStandaloneChromeProfile: this.form.field('launchStandaloneChromeProfile'),
      installHostAutomatically: this.form.field('installHostAutomatically'),
    }))
  }

  /**
   * 构造槽位注册要注入的面.
   *
   * @returns 卡片的状态快照与表单动作.
   */
  inject(): PairingCardFace {
    return { hooks: { pairingForm: this.store }, ...this.form.actions() }
  }

  /** 释放表单订阅. */
  dispose(): void { this.form.dispose() }
}
