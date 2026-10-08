/**
 * 会话 Tab 的用户可见文案.
 *
 * 和设置页分开一份字典: 会话视图与插件配置页落在不同槽位, 文案职责也不一样,
 * 混在 settings.dsh-browser 里会让设置页字典里出现一堆它根本用不到的键.
 */

/** 会话 Tab 文案键. */
export type BrowserTabKey =
  | 'tab.label'
  | 'loading'
  | 'connected'
  | 'disconnected'
  | 'standalonePending'
  | 'holderSelf'
  | 'holderNone'
  | 'holderOther'
  | 'bound'
  | 'unbound'
  | 'ready'
  | 'notReady'
  | 'acquire'
  | 'takeOver'
  | 'release'
  | 'refresh'
  | 'acquiring'
  | 'releasing'
  | 'hint'
  | 'session'

/** 中文文案. */
export const zh: Record<BrowserTabKey, string> = {
  'tab.label': '浏览器',
  loading: '正在读取状态...',
  connected: '扩展已连接',
  disconnected: '扩展未连接',
  standalonePending: '独立 profile 尚未启动, 日常 Chrome 里的连接不算',
  holderSelf: '本会话持有驱动权',
  holderNone: '当前无人持有驱动权',
  holderOther: '现在由另一个会话占用',
  bound: '已绑定标签页',
  unbound: '尚未绑定标签页',
  ready: '链路就绪, 可以交给本会话',
  notReady: '链路还没配好, 先去插件配置页完成安装与配对',
  acquire: '获取本会话驱动权',
  takeOver: '接管到本会话',
  release: '释放驱动权',
  refresh: '刷新',
  acquiring: '正在获取...',
  releasing: '正在释放...',
  hint: '这里的获取等于你本人同意把浏览器交给这个会话, 不会再弹审批. 释放只作用于本会话当前持有的那份驱动权.',
  session: '本会话',
}

/** 英文文案. */
export const en: Record<BrowserTabKey, string> = {
  'tab.label': 'Browser',
  loading: 'Reading status...',
  connected: 'Extension connected',
  disconnected: 'Extension not connected',
  standalonePending: 'Standalone profile not launched yet; a daily Chrome link does not count',
  holderSelf: 'This session holds the browser',
  holderNone: 'No session holds the browser',
  holderOther: 'Another session currently holds the browser',
  bound: 'A tab is bound',
  unbound: 'No tab is bound yet',
  ready: 'Ready to grant this session',
  notReady: 'Not ready yet; finish install and pairing on the plugin settings page',
  acquire: 'Acquire for this session',
  takeOver: 'Take over for this session',
  release: 'Release',
  refresh: 'Refresh',
  acquiring: 'Acquiring...',
  releasing: 'Releasing...',
  hint: 'Acquire here is your own consent to give this session the browser, so no approval prompt is shown. Release only drops the grant if this session currently holds it.',
  session: 'This session',
}
