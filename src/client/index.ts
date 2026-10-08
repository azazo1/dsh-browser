/**
 * Client 半区入口: 设置页与会话 Tab.
 *
 * 设置页落点选 `plugins.bundle.config` 而不是 `plugins.item`: 这个包只有一份配置,
 * 前者的键是包名, 正对本包; 后者是官方插件列表用的, 外部插件不应占用.
 *
 * 会话 Tab 落点是 `conversation.view`, 与设置页独立注册: 没打开设置页时会话里仍然要能
 * 获取 / 释放本会话的浏览器驱动权.
 */

// 类型导入: 引入 locale 服务的 Context 增强 (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型导入: ctx.slots 这个 SlotRegistry 的服务合并 (由 renderer 的 client face 提供).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// 类型导入: 'plugins.bundle.config' 这个 keyed slot 与 PluginConfigViewProps 的官方声明.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// 类型导入: ctx.configForms 这个服务合并 (由 ui-settings 的 client face 提供).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型导入: 'conversation.view' 这个 list slot 的官方声明.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { BrowserSettings } from './BrowserSettings.tsx'
import { BrowserTab } from './tab/BrowserTab.tsx'
import type { BrowserTabProps } from './tab/BrowserTab.tsx'
import { ENTRY_ID, PACKAGE_NAME } from './entry.ts'
import { PairingFormController } from './pairing-form.ts'
import { en, zh } from './strings.ts'
import type { BrowserSettingsKey } from './strings.ts'
import { en as tabEn, zh as tabZh } from './tab/strings.ts'
import type { BrowserTabKey } from './tab/strings.ts'

/** 设置页文案命名空间. */
export const NS = 'settings.dsh-browser'

/** 会话 Tab 文案命名空间. */
export const TAB_NS = 'dsh-browser.tab'

/** 需要的服务. `configForms` 用来渲染配对令牌的编辑表单. */
export const inject = ['slots', 'locale', 'configForms']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 浏览器连接设置页文案. */
    'settings.dsh-browser': BrowserSettingsKey
    /** 会话浏览器 Tab 文案. */
    'dsh-browser.tab': BrowserTabKey
  }
}

/**
 * 挂载设置页.
 *
 * `plugins.bundle.config` 必须经 `ctx.slots.inject` 注册, 不能直接 `ctx.slots.register`:
 * 这个槽位由插件管理页在它自己的 children 表里声明, 而 slot registry 对"尚未声明的
 * 槽位"会直接抛错 (`slot "..." is not declared`). 直接注册能否成功因此取决于两个
 * client 模块的加载顺序, 顺序不巧时 apply 抛异常, 浏览器侧只显示
 * `web boot: 1 entry did not activate / dsh-browser: failed`, 页面上连卡片都不出现,
 * 而 Host 侧日志一切正常.
 *
 * `slots.inject` 做的正是"等声明出现再回调, 声明消失时自动注销", 所以它是这里的正确
 * 入口. 官方插件与本机可用的 dsh-plugin-chrome 都走这条路.
 *
 * @param ctx Client 插件上下文.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const tabT = ctx.locale.bind(TAB_NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-browser: dictionaries')
  ctx.effect(() => ctx.locale.register(TAB_NS, { zh: tabZh, en: tabEn }), 'dsh-browser: tab dictionaries')

  // 配对令牌的表单: 没有它, 卡片上就没有任何可填配置的地方 —— 而提示却让用户去填那个字段.
  const pairing = new PairingFormController(ctx.configForms.get(ENTRY_ID))
  ctx.effect(() => () => { pairing.dispose() }, 'dsh-browser: pairing form')

  ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject(
    'plugins.bundle.config',
    () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: PACKAGE_NAME,
      locale: NS,
      // t 给文案; pairing 给令牌表单的状态与动作 (编辑 / 重置 / 保存 / 放弃).
      inject: () => ({ t: (key: BrowserSettingsKey) => t(key), ...pairing.inject() }),
    }, BrowserSettings),
  )), 'dsh-browser: settings page')

  ctx.effect(() => registerTab(ctx, tabT), 'dsh-browser: session tab')
}

/**
 * 注册会话级浏览器 Tab.
 *
 * 与设置页独立: 这个槽由会话页声明, 设置页声明与否不影响它. 不复刻实时画面,
 * 只做本会话的获取 / 释放.
 *
 * @param ctx Client 上下文.
 * @param t Tab 命名空间的文案函数.
 */
function registerTab(ctx: ClientContext, t: BrowserTabProps['t']): () => void {
  return ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dsh-browser',
    order: 41,
    label: () => t('tab.label'),
    locale: TAB_NS,
    inject: (sessionId: string) => ({ t, sessionId }),
  }, BrowserTab))
}
