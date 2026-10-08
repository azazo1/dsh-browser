/**
 * Client 半区用到的两个寻址名.
 *
 * 单独一个**无依赖**模块, 因为这两个值要被测试直接断言 (见
 * `tests/pairing-entry-id.test.ts`), 而从表单实现里导入会连带拖进 ui-primitives 那一串
 * 浏览器侧依赖, 在 node 环境下跑不起来.
 */

/**
 * 本插件在 profile 组合里的条目 id.
 *
 * 必须与 `cordis.patch.yml` 里 insert 的那行 `id` 一致: 设置表单是按**条目 id**寻址的, 而不是
 * 按包名. 两者不一致时界面一切正常, 只是那张卡上没有配置区 —— 属于最难查的一类静默失败, 所以
 * 有测试盯着这个常量与 patch 文件.
 */
export const ENTRY_ID = 'dsh-browser'

/**
 * `plugins.bundle.config` 这个 keyed slot 的键, 也就是包名.
 *
 * 与 ENTRY_ID 是两件事: 槽位按包名寻址, 表单按条目 id 寻址. 本包只有一行, 所以两者恰好相同;
 * 拆成多行时它们就会分道扬镳.
 */
export const PACKAGE_NAME = 'dsh-browser'
