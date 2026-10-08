/**
 * 配对令牌的编辑表单.
 *
 * 为什么必须自己接这一层: `plugins.bundle.config` 槽**不会**拿到框架给的 `form` 助手 ——
 * 对比一下就清楚, `plugins.item` 与 `plugins.row.config` 的 owner props 里都有 `form`, 而
 * bundle 那一处只传了 `{ view: 'page' }`. 也就是说: 除非插件自己把配置表单渲染出来, 否则
 * 卡片上**根本没有任何地方能填配置**.
 *
 * 这正是曾经的现实: 提示里让用户"把令牌填到 pairingToken 字段", 而界面上压根没有那个字段.
 * 一个只出现在报错文案里的配置项, 等于没有.
 *
 * 写法照官方最小示例 (`ui-settings-shell`): 用 `ctx.configForms.get(条目 id)` 拿共享表单,
 * 用 `SettingsFormModel` 暂存草稿, 保存时才写回. 保存是唯一的写入口 —— 边打字边写会让一次
 * 编辑变成多次用户没有要求也无法预览的写入.
 */

import { SettingsFormModel, settingsTextField } from '@deepseek-ai/dsh-client-ui-primitives'
import { ENTRY_ID } from './entry.js'
import type {
  SettingsFieldState,
  SettingsFormActions,
  SettingsFormScope,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

export { ENTRY_ID } from './entry.js'

/** 本页编辑的配置字段. */
export interface PairingSettings {
  /** 扩展生成、由用户抄过来的配对令牌. */
  pairingToken?: string
}

/** 卡片渲染需要的状态. */
export interface PairingCardState extends SettingsFormShell {
  /** 令牌字段的暂存状态. */
  pairingToken: SettingsFieldState
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
    // 用标准文本字段而不是密文字段: 这个值需要**核对**. 用户从扩展面板抄一长串过来, 若界面上
    // 看不到已保存的值, 出现不一致时他无从判断是自己抄错了还是别的问题. 而密文字段的语义是
    // "留空即保持原值", 也就无法清空令牌 —— 需要撤销授权时反而做不到.
    this.form = new SettingsFormModel(scope, [settingsTextField('pairingToken')])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      pairingToken: this.form.field('pairingToken'),
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
