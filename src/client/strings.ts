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
  install: '安装连接组件',
  uninstall: '卸载连接组件',
  refresh: '刷新状态',
  installing: '正在安装...',
  manualTitle: '需要手动完成的一步',
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
  install: 'Install connection pieces',
  uninstall: 'Uninstall connection pieces',
  refresh: 'Refresh',
  installing: 'Installing...',
  manualTitle: 'One manual step',
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
}
