/**
 * 构建脚本.
 *
 * 这个仓库有四个构建面, 都是普通 esbuild 调用, 刻意不引入更重的构建框架:
 *
 *   lib/index.js       Host 半区, ESM, 供 cordis Loader 加载.
 *   lib/nm-host.cjs    native messaging host, 独立可执行脚本 (由 Chrome 拉起; 必须是 CJS).
 *   lib/client.js      Client 半区, 顶层注册 __ModuleLoader__.
 *   assets/extension/  扩展产物, 会被复制到用户数据目录供 Chrome 加载.
 *
 * 两个容易出错的点在这里显式处理:
 *
 *   1. Host 半区必须把运行时依赖保持成外部 import. 它们由 dsh 的安装提供, 打进产物
 *      会造成同一模块的两份实例, cordis 的服务注册会因此失配. 而且 ws 是 CommonJS,
 *      把它内联进 ESM 产物会让 esbuild 生成 `require("events")`, 在 ESM 下直接抛
 *      "Dynamic require of events is not supported" —— 现象是整个插件加载失败, 而
 *      dsh 只打印一句 "failed to import", 完全看不出原因.
 *
 *   2. `lib/nm-host.cjs` **必须完全自包含**, 因为它由 Chrome 在任意工作目录下拉起,
 *      node 的模块解析不会经过这个包的 node_modules. 那里必须内联 ws; 之所以能把
 *      CJS 内联进去, 是因为那个产物本身就是 CJS 格式.
 */

import { build } from 'esbuild'
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(ROOT)

/**
 * Host 半区保持外部的包.
 *
 * 三类都必须留在外面:
 *   - `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`: 由 dsh 提供, 内联会造成
 *     服务注册表的两份实例.
 *   - `ws`: 它是 CommonJS. Host 半区是 ESM 产物, 把 CJS 内联进去会让 esbuild 生成
 *     `require(...)`, 而 ESM 里没有 require, 运行时就抛
 *     "Dynamic require of \"events\" is not supported". 保持外部则变成普通的
 *     `import { WebSocket } from "ws"`, node 自己会处理 CJS↔ESM 互操作.
 */
const HOST_EXTERNAL = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'ws']

/** 判断一个 import 是否属于 Host 半区的外部项. */
function isHostExternal(specifier) {
  return HOST_EXTERNAL.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

/** 读 package.json 里的插件名, Client 半区注册时必须用它. */
async function pluginName() {
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error('package.json 缺少 name')
  }
  return manifest.name
}

/** 构建 Host 半区. */
async function buildHost() {
  await build({
    entryPoints: [join(REPO_ROOT, 'src/index.ts')],
    outfile: join(REPO_ROOT, 'lib/index.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: true,
    packages: 'bundle',
    external: HOST_EXTERNAL,
    // 动态 require 与 import.meta 在 ESM 产物里的告警对本次用法无意义.
    logOverride: { 'require-resolve-not-external': 'silent' },
    banner: {
      js: '// 由 scripts/build.mjs 生成, 请勿直接编辑; 改 src/index.ts 后重新构建.',
    },
  })
}

/**
 * 校验 Host 半区产物在 ESM 下可用.
 *
 * 具体查两件事, 都是"产物看着正常但一加载就死"的类型:
 *   - 出现 `require(...)` 的兜底实现 (esbuild 内联 CJS 时生成), 它在 ESM 里会抛
 *     "Dynamic require of ... is not supported";
 *   - 出现顶层 `await import` 之外的对内联模块的引用约定.
 *
 * 这类问题在 dsh 里只表现为一句 "failed to import", 排查成本极高, 所以在构建期拦住.
 *
 * @param file Host 半区产物路径.
 */
async function verifyHostBundle(file) {
  const text = await readFile(file, 'utf8')
  if (text.includes('Dynamic require of "') || /var __require\s*=/.test(text)) {
    throw new Error(
      'Host 半区产物里出现了 CommonJS 的 require 兜底实现, 说明有 CJS 依赖被内联进了 ESM 产物. '
      + '这会在 dsh 加载插件时抛 "Dynamic require of ... is not supported", 表现为 "failed to import". '
      + '请把该依赖加进 HOST_EXTERNAL.',
    )
  }
}

/**
 * 确认 Host 半区的每个外部依赖都能被解析.
 *
 * 留着外部依赖的前提是"这些包在运行时真的找得到". 这里显式解析一遍, 免得改错包名
 * 之后要等到 dsh 启动才发现.
 *
 * @param file Host 半区产物路径.
 */
async function verifyHostExternalsResolvable(file) {
  const text = await readFile(file, 'utf8')
  const specifiers = new Set(
    [...text.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gmu)]
      .map(match => match[1])
      .filter(specifier => specifier !== undefined && !specifier.startsWith('node:')),
  )
  const { createRequire } = await import('node:module')
  const require = createRequire(join(REPO_ROOT, 'package.json'))
  for (const specifier of specifiers) {
    try {
      require.resolve(specifier)
    } catch {
      throw new Error(`Host 半区引用了无法解析的模块 "${specifier}"; 它必须由 dsh 的安装提供.`)
    }
  }
}

/** 构建 native messaging host. */
async function buildNativeHost() {
  await build({
    entryPoints: [join(REPO_ROOT, 'src/native-host/host-entry.ts')],
    outfile: join(REPO_ROOT, 'lib/nm-host.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    // 完全自包含: Chrome 从任意目录拉起它, 走不到本包的 node_modules.
    // ws 的两个可选加速依赖留作 external —— 它们本来就只在装了的时候才用, ws 自己
    // 用 try/catch 兜底.
    external: ['bufferutil', 'utf-8-validate'],
    banner: {
      js: '// 由 scripts/build.mjs 生成; Chrome 直接启动这个文件, 必须自包含.',
    },
  })
}

/** 构建 Client 半区并套上 __ModuleLoader__ 包装. */
async function buildClient() {
  const id = await pluginName()
  const result = await build({
    entryPoints: [join(REPO_ROOT, 'src/client/index.ts')],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    write: false,
    sourcemap: false,
    globalName: '__dshBrowserClient',
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    jsx: 'automatic',
    loader: { '.tsx': 'tsx' },
  })
  const body = result.outputFiles[0]
  if (body === undefined) throw new Error('client 构建没有产出')
  // Client bundle 必须在顶层调用 __ModuleLoader__.load 且 id 与包名完全一致,
  // 否则浏览器半区会静默缺席 boot graph.
  const wrapped = [
    `// 由 scripts/build.mjs 生成, 请勿直接编辑; 改 src/client/ 后重新构建.`,
    `window.__ModuleLoader__.load({`,
    `  id: ${JSON.stringify(id)},`,
    `  factory: (require) => {`,
    body.text,
    `    return __dshBrowserClient;`,
    `  },`,
    `});`,
    ``,
  ].join('\n')
  await writeFile(join(REPO_ROOT, 'lib/client.js'), wrapped, 'utf8')
}

/** 打包扩展产物到 assets/extension. */
async function buildExtension() {
  const extensionRoot = join(REPO_ROOT, 'extension')
  const outDir = join(REPO_ROOT, 'assets/extension')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // 后台 service worker 与弹窗脚本; 都内联成单文件, 因为扩展页不允许外部脚本之外的
  // 加载方式, 且 MV3 的 service worker 不便处理裸模块说明符.
  await build({
    entryPoints: [join(extensionRoot, 'src/background/index.ts')],
    outfile: join(outDir, 'background.js'),
    bundle: true,
    platform: 'browser',
    target: 'chrome116',
    format: 'esm',
    sourcemap: false,
    // 注入函数不能引用外部模块, 内联是无害的: injected.ts 里的函数本身自包含,
    // 打包器只在别处产生模块边界.
    external: [],
  })
  await build({
    entryPoints: [join(extensionRoot, 'src/panel/popup.ts')],
    outfile: join(outDir, 'popup.js'),
    bundle: true,
    platform: 'browser',
    target: 'chrome116',
    format: 'iife',
    sourcemap: false,
  })

  // 静态资源原样复制.
  await cp(join(extensionRoot, 'manifest.json'), join(outDir, 'manifest.json'))
  await cp(join(extensionRoot, 'popup.html'), join(outDir, 'popup.html'))
  await cp(join(extensionRoot, 'popup.css'), join(outDir, 'popup.css'))
  await cp(join(extensionRoot, '_locales'), join(outDir, '_locales'), { recursive: true })
  await cp(join(extensionRoot, 'assets'), join(outDir, 'assets'), { recursive: true })
  return outDir
}

/**
 * 校验扩展产物: 清单里的图标与脚本都必须真实存在.
 *
 * 这一步是必要的而不是多余的: 图标缺失或 background 路径写错时, Chrome 只在
 * chrome://extensions 上留一条容易忽略的提示, 用户看到的现象是"加载了却什么都没发生".
 *
 * @param outDir 扩展产物目录.
 */
async function verifyExtension(outDir) {
  const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'))
  const problems = []
  const { access } = await import('node:fs/promises')
  const check = async (relative) => {
    try {
      await access(join(outDir, relative))
    } catch {
      problems.push(`清单引用的文件不存在: ${relative}`)
    }
  }
  for (const path of Object.values(manifest.icons ?? {})) await check(path)
  for (const path of Object.values(manifest.action?.default_icon ?? {})) await check(path)
  await check('popup.html')
  const background = manifest.background?.service_worker
  if (typeof background !== 'string') problems.push('清单缺少 background.service_worker')
  else await check(background)
  if (typeof manifest.key !== 'string' || manifest.key === '') {
    // 没有 key 时扩展 ID 会随目录路径漂移, native messaging 清单会随之失配.
    problems.push('清单缺少 key 字段: 扩展 ID 会随目录路径变化, 请先运行 node scripts/extension-identity.mjs gen 并填入')
  }
  if (problems.length > 0) throw new Error(`扩展产物校验失败:\n- ${problems.join('\n- ')}`)
}

/**
 * 校验 native host 产物的自包含性.
 *
 * 检查它没有把"真的需要外部解析"的模块说明符留成 require 调用 —— 那会在 Chrome
 * 拉起它时直接失败, 而失败现象是"扩展一直显示未连接", 很难定位. 这里提前把问题
 * 变成构建错误.
 *
 * 两类名字不算问题:
 *   - node 内建模块. 带不带 `node:` 前缀都能被 Node 解析, esbuild 转成 CJS 时
 *     会保留原样.
 *   - ws 的两个可选加速依赖. ws 在运行时用 try/catch 探测它们, 缺失时退回纯 JS
 *     实现, 属于设计内行为 (它们也已被标记为 external, 不会被内联).
 *
 * @param file 产物路径.
 */
async function verifyNativeHost(file) {
  const { builtinModules } = await import('node:module')
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
  /** 允许缺失的可选依赖; 每个都必须在运行时被调用方兜住. */
  const optionalAtRuntime = new Set(['bufferutil', 'utf-8-validate'])
  const text = await readFile(file, 'utf8')
  const offenders = [...text.matchAll(/require\((["'])([^"']+)\1\)/gu)]
    .map(match => match[2])
    .filter(specifier => specifier !== undefined
      && !specifier.startsWith('.')
      && !specifier.startsWith('/')
      && !builtins.has(specifier)
      && !optionalAtRuntime.has(specifier))
  if (offenders.length > 0) {
    const unique = [...new Set(offenders)]
    throw new Error(
      `nm-host.cjs 没有自包含, 残留了这些需要在运行时解析的外部依赖: ${unique.join(', ')}. `
      + 'Chrome 从任意工作目录启动它, 走不到本包的 node_modules; 请把它们加进 buildNativeHost 的内联范围.',
    )
  }
}

async function main() {
  await rm(join(REPO_ROOT, 'lib'), { recursive: true, force: true })
  await mkdir(join(REPO_ROOT, 'lib'), { recursive: true })

  console.log('构建 Host 半区...')
  await buildHost()
  await verifyHostBundle(join(REPO_ROOT, 'lib/index.js'))
  await verifyHostExternalsResolvable(join(REPO_ROOT, 'lib/index.js'))
  console.log('构建 native messaging host...')
  await buildNativeHost()
  await verifyNativeHost(join(REPO_ROOT, 'lib/nm-host.cjs'))
  console.log('构建 Client 半区...')
  await buildClient()
  console.log('打包扩展产物...')
  const extensionDir = await buildExtension()
  await verifyExtension(extensionDir)

  console.log('完成:')
  console.log(`  lib/index.js      Host 半区`)
  console.log(`  lib/nm-host.cjs   native messaging host (自包含)`)
  console.log(`  lib/client.js     Client 半区`)
  console.log(`  ${extensionDir}`)
}

await main()
