/**
 * 设置页的全部用户可见文案.
 *
 * 硬编码在组件里的文案无法翻译也无法统一修改, 所以这里集中声明, 由 client/index.ts
 * 通过 `ctx.locale.register` 注册成 typed 字典, 组件只拿 `t` 函数.
 */

/** 设置页文案键. */
export type BrowserSettingsKey =
  | 'title'
  | 'description'
  | 'loading'
  | 'ready'
  | 'notReady'
  | 'checkChrome'
  | 'checkHost'
  | 'checkExtension'
  | 'checkBinding'
  | 'checkEvaluate'
  | 'checkPairing'
  | 'checkLaunch'
  | 'install'
  | 'uninstall'
  | 'refresh'
  | 'installing'
  | 'manualTitle'
  | 'manualLoad'
  | 'copy'
  | 'copied'
  | 'details'
  | 'chromePath'
  | 'profileDir'
  | 'extensionDir'
  | 'manifestPath'
  | 'extensionId'
  | 'interpreter'
  | 'launchArgs'
  | 'boundTab'
  | 'none'
  | 'stale'
  | 'tokenLabel'
  | 'tokenHint'
  | 'tokenPlaceholder'
  | 'tokenApply'
  | 'tokenSaved'
  | 'launchLabel'
  | 'launchHint'
  | 'installAutoLabel'
  | 'installAutoHint'
  | 'overridden'
  | 'reset'
  | 'save'
  | 'saving'
  | 'formUnavailable'
  | 'formReadOnly'
  | 'formSaveFailed'

/** 中文文案. */
export const zh: Record<BrowserSettingsKey, string> = {
  title: '浏览器连接',
  description: '不使用 Chrome 调试协议, 通过浏览器扩展与 native messaging 驱动本机的 Google Chrome.',
  loading: '正在读取状态...',
  ready: '可以开始使用',
  notReady: '还没有就绪',
  checkChrome: 'Chrome',
  checkHost: '连接组件',
  checkExtension: '扩展连接',
  checkBinding: '绑定标签页',
  checkEvaluate: '浏览器求值',
  checkPairing: '配对令牌',
  checkLaunch: '浏览器启动方式',
  install: '安装连接组件',
  uninstall: '卸载连接组件',
  refresh: '刷新状态',
  installing: '正在安装...',
  manualTitle: '需要手动完成',
  manualLoad: 'Chrome 只允许用户本人加载未打包的扩展. 打开 chrome://extensions, 开启右上角的开发者模式, 点"加载已解压的扩展程序", 然后选中下面这个目录. 装一次即可, 之后重启浏览器都会自动加载.',
  copy: '复制路径',
  copied: '已复制',
  details: '查看细节',
  chromePath: 'Chrome 路径',
  profileDir: '持久 profile',
  extensionDir: '扩展目录',
  manifestPath: 'native 清单',
  extensionId: '扩展 id',
  interpreter: '解释器',
  launchArgs: '启动参数',
  boundTab: '绑定标签页',
  none: '无',
  stale: '检测到已装的连接组件与当前配置不一致 (可能换过数据目录或扩展密钥). 点"安装连接组件"即可重装.',
  tokenLabel: '配对令牌',
  tokenHint: '点浏览器工具栏上的 dsh Browser 图标, 复制弹出面板里的配对令牌, 粘贴到这里再点保存. '
    + '令牌直接写进本机数据目录, 不进配置文件, 因此不会跟着 dsh 的配置同步到别的设备. '
    + '这个值明文显示, 因为它需要和扩展面板里那串核对.',
  tokenPlaceholder: '粘贴扩展面板里显示的令牌',
  tokenApply: '保存令牌',
  tokenSaved: '令牌已保存到本机数据目录, 配置文件里没有它.',
  launchLabel: '启动独立 profile 的 Chrome',
  launchHint: '关闭时永远不自行打开 Chrome, 只用扩展已经连上的那个浏览器. 打开后 dsh 会用一份全新的独立 profile 启动 Chrome, 不再复用你日常那个窗口; 那份 profile 没有登录态, 需要单独再加载一次扩展.',
  installAutoLabel: '自动同步连接组件',
  installAutoHint: '开启后, 插件每次加载和每个会话开始使用浏览器前, 都会把扩展产物与 native messaging 组件同步到数据目录 (幂等). 插件升级后你只需在 chrome://extensions 里刷新一次扩展; 关闭则要手动回来点"安装连接组件".',
  overridden: '已覆盖',
  reset: '恢复默认',
  save: '保存',
  saving: '正在保存...',
  formUnavailable: '这个配置项当前没有被任何 profile 条目服务, 因此无法编辑.',
  formReadOnly: '当前部署的配置是只读的, 保存会被拒绝.',
  formSaveFailed: '保存没有生效, 草稿已保留, 请修正后重试.',
}

/** 英文文案. */
export const en: Record<BrowserSettingsKey, string> = {
  title: 'Browser connection',
  description: 'Drives your local Google Chrome through a browser extension and native messaging. No Chrome DevTools Protocol.',
  loading: 'Reading status...',
  ready: 'Ready to use',
  notReady: 'Not ready yet',
  checkChrome: 'Chrome',
  checkHost: 'Connection pieces',
  checkExtension: 'Extension link',
  checkBinding: 'Bound tab',
  checkEvaluate: 'In-page evaluate',
  checkPairing: 'Pairing token',
  checkLaunch: 'Browser launch',
  install: 'Install connection pieces',
  uninstall: 'Uninstall connection pieces',
  refresh: 'Refresh',
  installing: 'Installing...',
  manualTitle: 'Manual step',
  manualLoad: 'Chrome only lets the user load an unpacked extension. Open chrome://extensions, turn on Developer mode, click "Load unpacked", and select the directory below. This is needed once; later browser restarts load it automatically.',
  copy: 'Copy path',
  copied: 'Copied',
  details: 'Show details',
  chromePath: 'Chrome path',
  profileDir: 'Persistent profile',
  extensionDir: 'Extension dir',
  manifestPath: 'Native manifest',
  extensionId: 'Extension id',
  interpreter: 'Interpreter',
  launchArgs: 'Launch args',
  boundTab: 'Bound tab',
  none: 'none',
  stale: 'The installed connection pieces do not match the current configuration (the data directory or extension key changed). Click "Install connection pieces" to reinstall.',
  tokenLabel: 'Pairing token',
  tokenHint: 'Open the dsh Browser popup from the toolbar, copy its pairing token, paste it here and save. '
    + 'The token is written straight into the local data directory and never enters the config file, so it will not sync to other devices with your dsh config. '
    + 'The value is shown in clear because it must be compared with the popup.',
  tokenPlaceholder: 'Paste the token shown in the extension popup',
  tokenApply: 'Save token',
  tokenSaved: 'Token saved into the local data directory; it is not in the config file.',
  launchLabel: 'Launch a standalone Chrome profile',
  launchHint: 'Off: never open Chrome; only reuse the browser whose extension is already connected. On: dsh launches a fresh independent profile and will not reuse your daily Chrome. That profile has no login state and needs the extension loaded once.',
  installAutoLabel: 'Sync connection pieces automatically',
  installAutoHint: 'On: every plugin load and every session re-syncs the extension build and native messaging pieces into the data directory (idempotent). After a plugin upgrade you only need to reload the extension once in chrome://extensions. Off: click "Install connection pieces" manually.',
  overridden: 'Overridden',
  reset: 'Reset',
  save: 'Save',
  saving: 'Saving...',
  formUnavailable: 'No profile entry serves this configuration, so it cannot be edited.',
  formReadOnly: 'This deployment stores settings read-only, so saving would be refused.',
  formSaveFailed: 'The save did not land; your draft is kept, fix it and try again.',
}
