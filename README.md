# dsh-browser

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接到本机真实的 Google Chrome 上, **不使用 Chrome 调试协议**.

页面被转成带编号的文本清单交给模型操作, 不截图, 因此也不需要视觉模型. Chrome 用一个持久的独立 profile, 登录态与浏览历史跨会话保留.

## 为什么不走 CDP

Puppeteer / Playwright 一类工具挂上浏览器时会发出 `Runtime.enable`, 这个命令的副作用可以被页面里几行 JavaScript 探测到, 主流反爬厂商都在用这个信号 ([DataDome 的分析](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/)). 加上 `navigator.webdriver` 和"全新空白 profile"这两个加分项, 结果就是频繁撞验证码.

本插件把这一整类特征摘掉:

| | 常见 CDP 方案 | 本插件 |
|---|---|---|
| 启动参数 | `--remote-debugging-port` / `--headless` | 只有 `--user-data-dir` 与两个跳过引导的开关 |
| 控制通道 | DevTools Protocol WebSocket | 浏览器扩展 + native messaging |
| Chrome 扩展 | 常被 `--disable-extensions` 关掉 | 可用, 而且**就是**控制通道 |
| profile | 每会话一个全新目录 | 一个持久目录, 登录态累积 |
| 页面与 harness 之间 | 调试协议 | Chrome 自己管理的 stdio 管道 |

**需要说清楚的边界**: 去掉 CDP 摘掉的是"检测到自动化工具"这一类特征. IP 信誉, UA 与指纹, 行为节奏这些都和 CDP 无关, 照旧可能让你遇到验证. 本插件不能承诺"绝对不弹验证".

## 它是怎么连起来的

```
真实的 Google Chrome
  └─ 扩展 (MV3)
       │ chrome.runtime.connectNative()      ← 没有端口, 没有 CDP
       ▼
     native messaging host (node 进程, 由 Chrome 按清单拉起)
       │ ws://127.0.0.1:<dsh 端口>/ext/bridge ← 地址与令牌从会合文件里读
       ▼
     dsh 插件 (注册 browser_* 工具)
       ▼
     Agent
```

关键在中间那一跳: 扩展**不需要知道 dsh 跑在哪个端口**. 它只说"启动我的 native host", Chrome 负责把进程拉起来并建立管道; host 则从 dsh 写下的会合文件里读到真实地址. 所以 dsh 换端口、随机端口都不影响.

## 安装

### 1. 装插件

```shell
dsh plugin --profile desktop add azazo1/dsh-browser
```

或者从源码装:

```shell
git clone https://github.com/azazo1/dsh-browser
dsh plugin --profile web add ./dsh-browser
```

装完重启 dsh.

### 2. 在配置页装连接组件

打开 **设置 -> 插件 -> dsh-browser**, 点 **安装连接组件**. 这一步做三件事:

- 把扩展产物复制到 dsh 的数据目录;
- 生成 native messaging 清单, 写上与本扩展公钥相符的扩展 id;
- 生成一个启动包装脚本, 里面写死 node 的绝对路径 (Chrome 直接 exec 它, 不经过 shell, 走不到 PATH).

清单写入用户目录, **不需要 root**:

| 平台 | 位置 |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/` |
| Windows | 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\` |

### 3. 手动加载一次扩展

Chrome 从 33 起就只接受商店来源或企业策略强制的扩展, 命令行装载也在 Chrome 154 被禁掉 (`--load-extension is not allowed in Google Chrome`). 所以**这一步只能由你本人点**:

1. 打开 `chrome://extensions`, 右上角开启开发者模式;
2. 点"加载已解压的扩展程序";
3. 选中配置页上显示的那个扩展目录 (用页面上的复制按钮最省事);
4. 回到配置页, 状态会自动变绿.

用 `unpacked` 方式加载的扩展**没有自动更新**, 每次改扩展都要回 `chrome://extensions` 手动 reload. 想要零手工和自动更新, 就走 Chrome 应用商店 (见下面的"发布").

### 4. (可选) 打开浏览器求值开关

`browser_evaluate` 需要在扩展详情页手动打开 **Allow User Scripts**:

1. 打开 `chrome://extensions`, 找到 dsh Browser, 点 **详情**;
2. 打开 **Allow User Scripts** 开关 (Chrome 138 之前是打开右上角的开发者模式);
3. 重新加载扩展。

为什么非开不可: 扩展页面与 ISOLATED world 的 CSP 是 `script-src 'self'`, 官方明确不允许追加
`'unsafe-eval'`, 所以 `new Function` 在那两个环境里被挡; `chrome.scripting.executeScript` 又只收函数
不收代码字符串。只有 `chrome.userScripts` 的 `USER_SCRIPT` world 豁免页面 CSP 且接受代码字符串,
它的代价就是这个开关。

**不开也能用**: 其余 16 个工具不受影响, 只是 `browser_evaluate` 会明确告诉你开关没开, 并建议改用
`browser_query`。配置页与 `browser_status` 都会显示这个开关的状态。

## 使用

装好之后, Agent 就有了这些工具:

| 工具 | 作用 |
|---|---|
| `browser_status` | 查询整条链路的状态与待办 |
| `browser_open` | 启动 (或复用) 持久 Chrome, 可顺带打开一个地址 |
| `browser_tabs` | 列出标签页 |
| `browser_select_tab` | 绑定一个标签页作为操作目标 |
| `browser_snapshot` | 取页面结构: 元素编号清单 + 正文 |
| `browser_text` | 只取正文, 更省上下文 |
| `browser_click` / `browser_fill` | 按快照编号点击 / 填入 |
| `browser_press_key` | 发送按键 |
| `browser_scroll` | 滚动 (会报告是否到底) |
| `browser_navigate` | 跳转地址 |
| `browser_wait` | 等待页面出现指定文本 |
| `browser_query` | 按 CSS 选择器批量取数据 (文本 + 属性), 含隐藏元素 |
| `browser_hover` | 悬停到编号元素, 触发下拉菜单一类只认鼠标移入的界面 |
| `browser_upload` | 把本机文件装进 `input[type=file]`, 按选择器定位 (文件输入框通常是隐藏的) |
| `browser_screenshot` | 截当前视口存成图片文件并返回路径 |
| `browser_evaluate` | 在页面里执行 JS 表达式取回结果 (需要额外开关, 见下) |

工具之间的分工值得说清楚, 因为它们看起来有重叠:

- `browser_snapshot` 只列**可见的可交互元素**并给编号, 目的是**操作**; `browser_query` 返回**全部**
  匹配项的文本与属性, 目的是**读数**. 两者不共用过滤条件。
- `browser_text` 读整页正文; `browser_query` 取局部结构; `browser_evaluate` 算东西或读页面 JS 变量。
- `browser_screenshot` 只截**当前视口**, 而且**不把图片发给模型**: 它落成文件并返回路径。能看图的
  模型接着用 `read_image` 读这个路径; 不能看图的模型把路径交给用户。这样图片的限额, 缩放与
  模型能力判断都由 harness 已有的 `read_image` 负责, 插件不重复实现一遍。

两个使用上的要点:

- **页面操作只作用于被绑定的那个标签页.** 必须先 `browser_select_tab`. 这是有意的: 没有"跟随用户当前标签"这种隐式行为, 免得你在别的标签页上看东西时被改到.
- **快照编号会失效.** 页面一变, 上一次 `browser_snapshot` 的编号就不能用了, 工具会明确报错让你重新取, 而不是点到一个已经变了的元素上.

## 多个会话与浏览器驱动权

浏览器平面是**独占**的: 分发给扩展的持久 profile 只有一个, 扩展内部也只维持一个"当前绑定标签页".
两个会话同时驱动同一个浏览器会互相踩, 所以插件把它做成一份**可申请的驱动权**。

| 情况 | 行为 |
|---|---|
| 会话第一次调用会占用浏览器的工具 | 弹一次审批, 由用户决定给不给 |
| 用户同意 | 该会话取得驱动权; 若原本在别人手上, 一并收回 |
| 同一会话继续调用 | 直接用, 不再询问 |
| 浏览器归别的会话 | 本会话调用时照样弹审批; 同意即可交过来, 对方之后的调用会重新申请 |
| 会话结束或被切走 | 驱动权自动回到无人持有 |
| `browser_release` | 主动交出, 不必等会话结束 |

`browser_status` 不占用浏览器, 所以不需要申请 —— 它也是第二个会话在申请之前查看"现在归谁"的入口。

申请走的是 harness 标准的审批通道 (同一个应答者, 同样在会话日志里留 `approval/asked` 与
`approval/decided` 审计对), 所以它遵守会话的审批策略, 也可以被 `auto-review` 一类插件自动应答。

**没有审批通道时是拒绝而不是放行**: "静默取得浏览器"正是要避免的行为。要在无人值守环境里用,
就显式把 `askOnAcquire` 关掉。

## 配置

在 profile 的 patch 层里按条目 id `dsh-browser` 覆盖:

```yaml
- id: dsh-browser
  config:
    # Chrome 可执行文件; 省略时按平台探测稳定版安装位置.
    chromePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
    # 持久 profile 目录; 省略时用 <DSH_HOME>/data/dsh-browser/profile.
    profileDir: ~/chrome-for-dsh
    # 额外启动参数, 每项一个完整参数. 会破坏本插件前提的参数会被拒绝.
    extraArgs: []
    # 会话第一次使用浏览器前是否征求用户同意 (即"申请"). 默认开启.
    askOnAcquire: true
    # 插件加载时是否自动写 native messaging 清单. 默认关闭.
    installHostAutomatically: false
```

`extraArgs` 会拒绝 `--remote-debugging-port`, `--headless`, `--disable-extensions`, `--user-data-dir` 等参数并在启动时报错: 它们与本插件的前提直接冲突, 静默接受会让"为什么又弹验证了"变得无从排查.

## 开发

```shell
just install     # 安装依赖
just verify      # 类型检查 + 构建 + 测试
just build       # 重建 lib/ 与 assets/extension
just test        # 只跑测试
just icons       # 重新生成扩展图标
just extension-id  # 打印扩展 id
```

### 仓库结构

```
src/
  index.ts          插件入口: 注册 provider, 工具, 系统提示, 审批
  config.ts         配置 schema 与路径解析
  runtime.ts        会话所有权 (SessionResources) 与状态汇总
  server.ts         配置页用的同源 HTTP 接口
  chrome/           Chrome 定位与启动
  native-host/      native messaging 组件的生成与安装, host 本体
  bridge/           与 native host 的 WebSocket 通道
  tools/            模型可见的工具
  client/           配置页 (浏览器半区)
extension/          MV3 扩展源码
shared/             两侧共用的协议与状态类型
scripts/            构建, 图标生成, 扩展身份
tests/              见下
```

### 测试都在守什么

`pnpm test` 里有十组测试, 每一组对应一个会静默失效的环节:

- `injected-purity` —— 注入页面的函数会被 `toString()` 之后送进页面执行, 因此它不能引用模块作用域里的任何东西. 测试把函数源码放进一个干净的 `Function` 里求值 (没有闭包, 只有全局), 跑不通就说明它在真实页面里也会抛 `ReferenceError`.
- `bundle-purity` —— 同一件事, 但针对**打包产物**里那一份. 打包器降级语法时可能插入模块级 helper, 那会让注入函数在页面里炸掉, 而源码测试看不到.
- `native-host-install` —— 连接组件生成: 清单里的 `allowed_origins` 是否写对了扩展 id, 包装脚本是否用了绝对解释器路径并可执行, 重复安装是否幂等.
- `nm-host-relay` —— 把构建产物 `lib/nm-host.cjs` 当子进程真跑起来, 用真的 WebSocket 服务扮演 dsh 侧, 验双向转发, 分帧和令牌. 除了 Chrome 本身, 整条管道都真实走了一遍.
- `tool-output-contract` —— 用 harness **自己那个** `snapshotJsonValue` 逐个跑 17 个工具的真实 `execute` 路径, 桩只替换扩展那一层. 这条是踩坑之后加的: 曾经 `shared/methods.ts` 声明返回 `{ ok, note }` 而扩展只返回 `{ note }`, 于是产物里多出一个 `ok: undefined`, 被 harness 判为"不是 lossless JSON"而**整批拒掉**, 但动作其实生效了 —— 现象是"操作成功却报错", 而类型系统完全看不到这层不一致.
- `injection-args` —— 守 `undefined` 不能跨进程序列化这件事: `chrome.scripting.executeScript` 传参走 JSON, 所以省略可选参数时把 `undefined` 塞进参数数组会让调用直接失败 (报错只给一个下标, 不说原因). 曾经 `browser_scroll` 省略 `amount` 就必然失败, 而显式给 `amount` 正常.
- `evaluate-code` —— 浏览器求值的页面侧代码是以**字符串**送进浏览器的, 类型系统管不到; 这组测试直接跑生成的代码, 检查它语法正确, 结果形状固定, 并且把函数, DOM 节点, 循环引用, bigint 这些无法跨进程序列化的值都收敛成字符串.
- `rendezvous-timing` —— 会合文件的发布时机与内容: 它在**插件加载时**就要写好, 而不是等第一次工具调用, 否则扩展装好了宿主也连不上; 以及扩展已连接时不该再启动新 Chrome.
- `wrapper-exec` —— 实际执行生成出来的包装脚本. 曾经用 `exec VAR=value cmd` 的写法, 那在 POSIX sh 里是无效语法 (`exec: FOO=bar: not found`, 退出码 127), 只有在真跑一次时才暴露.
- `client-load` —— Client 半区只在页面打开时才求值, 所以它出错时宿主侧日志一切正常, 用户只看到 `web boot: 1 entry did not activate`. 这组用真 cordis Context 跑 `apply`, 且槽位桩复刻真实 registry 的两条硬规则 (槽位必须先被声明, keyed 槽位不能重复注册).

### 扩展身份

扩展 id 由 `extension/manifest.json` 里 `key` 字段 (公钥 DER 的 base64) 派生, 而不是由目录路径派生. 这一点是必须的: native messaging 清单里的 `allowed_origins` 要先把 id 写死, 如果 id 会随目录漂移, 清单立刻失配, 现象是"扩展一直显示未连接".

私钥在 `.tmp/extension-key.pem` (已 gitignore), 只在打包 `.crx` 时用. **换密钥等于换扩展 id**, 所有装过扩展的机器都要重新加载.

## 发布

### 打包

```shell
just verify
# 产物:
#   assets/extension/   直接可加载的 unpacked 目录 (含固定 key)
#   lib/                插件本体
```

### 上 Chrome 应用商店 (推荐)

商店会自己签名, 收的是 zip, 顺便解决两件事: 首次安装变成普通用户动作 ("添加至 Chrome"), 之后自动更新, 扩展 id 由商店固定. 注册开发者账号是一次性费用 (写作时是 5 美元), 提交后需要过审.

### 自己打包 crx

Chrome 自带的打包器仍然可用 (`--pack-extension` 没有被禁, 被禁的是 `--load-extension`):

```shell
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension=/path/to/assets/extension \
  --pack-extension-key=.tmp/extension-key.pem
```

但要清楚: **stable Chrome 不接受从外面拖进来的 crx**, 只接受商店来源或企业策略强制的扩展. 所以 crx 的用途是配合 `ExtensionInstallForcelist` 自托管更新源, 那需要 root 并会把机器标记为受管设备.

## 两条容易踩的插件编写约定

这两条都是本插件开发时真的踩过、而且现象极难定位的:

1. **不要 `export default apply`.** Loader 会拿 default 导出当插件本体去读它的 `inject` / `name`, 而函数身上并没有这些属性. 结果是插件被当成"没有声明任何注入", `apply` 里每一次 `ctx.<service>` 都抛 `cannot get property ... without inject`. 只导出具名成员 (`name` / `inject` / `apply` / `Config`), 与官方插件保持一致.

2. **Host 半区不能内联 CommonJS 依赖.** `lib/index.js` 是 ESM, 把 `ws` 这类 CJS 包打进去会让 esbuild 生成 `require(...)`, 在 ESM 下直接抛 `Dynamic require of "events" is not supported`. 这类依赖必须放进 `HOST_EXTERNAL`, 构建脚本里有断言拦住. 反过来, `lib/nm-host.cjs` 要求完全自包含, 所以它用 CJS 格式 —— 那里正该内联 `ws`.

两者在 dsh 侧的表现都只是日志里一句 `failed to import`, 没有任何堆栈. 所以构建期断言比事后排查划算得多.

## 已知限制

- **只支持 Google Chrome.** Chromium / Edge / Brave 的 native messaging 目录各不相同, 没有做探测.
- **页面在 iframe 里的内容取不到.** 快照只覆盖主框架.
- **文件上传靠内容重建, 不是真实路径.** 浏览器不允许脚本给 `input[type=file]` 指派磁盘路径, 所以 `browser_upload` 是把宿主读到的字节在页面里重建成 `File` 再装进去; 单次上限 24 MiB, 且文件输入框只能按选择器定位 (它通常是隐藏的, 不在快照编号表里).
- **Chrome 内部页面无法操作.** `chrome://` 与扩展商店页面禁止脚本注入.
- **一次只服务一个会话.** 浏览器平面是有状态的, 两个会话同时驱动会互相踩, 所以第二个会话会被明确拒绝而不是放进去造成难以复现的混乱.
- **截图只有当前视口, 而且不发给模型.** 整页需要滚动拼接, 而宿主侧没有图像库; 图片落成文件后由 `read_image` (能看图的模型) 或用户自己查看.
- **`browser_evaluate` 需要用户在扩展详情页手动打开开关.** 其余工具不受影响. 在页面 CSP 严格的站点上, `world: "main"` 可能被拒 (那是页面自己的限制), 默认的 `isolated` 不受影响.
- **`unpacked` 加载方式没有自动更新.** 每次改扩展要手动 reload.

## License

MIT
