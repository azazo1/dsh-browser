/**
 * native messaging 组件的落地与安装.
 *
 * 这一步解决的正是旧方案里最烦的那件事: 扩展不需要知道任何端口, 因为它调用
 * `chrome.runtime.connectNative`, 由 Chrome 按清单把这个进程拉起来.
 *
 * 但 Chrome 是**直接 exec** 清单里 path 的, 不经过 shell. 从 Finder 启动的 Chrome
 * 环境变量极少 (macOS 上 PATH 大致只有 /usr/bin:/bin:/usr/sbin:/sbin), 所以:
 *
 *   - 清单的 path 不能是 `#!/usr/bin/env node` 的裸脚本, 否则 Homebrew 装的 node
 *     根本找不到;
 *   - 也不能直接指向 dsh 的二进制, 因为清单没有传参的地方.
 *
 * 因此清单指向一个由本模块生成的包装脚本, 里面写死解释器的**绝对路径**和参数.
 * 解释器取 `process.execPath`: dsh 桌面端是 Electron 二进制, 需要额外设置
 * `ELECTRON_RUN_AS_NODE=1` 才能当 node 用, 这个判断也在这里做.
 */

import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { NATIVE_HOST_NAME } from '../../shared/protocol.js'
import type { ResolvedPaths } from '../config.js'

/** 扩展清单里承载公钥的字段名; 扩展 ID 由它派生而不是由目录路径派生. */
const MANIFEST_KEY_FIELD = 'key'

/** 包装脚本文件名, 按平台选一个. */
const WRAPPER_NAME = process.platform === 'win32' ? 'run.cmd' : 'run.sh'

/**
 * 宿主脚本在数据目录里的文件名.
 *
 * 必须是 `.cjs` 而不是 `.js`: 产物是 CommonJS 形态 (它内联了 ws, 而 ws 是 CJS),
 * 而本包的 package.json 声明了 `"type": "module"`. 若用 `.js`, 任何能向上找到
 * 那份 package.json 的场景都会把它按 ESM 解析, 于是 `require is not defined`
 * 直接崩掉. `.cjs` 不看 package.json, 永远按 CommonJS 解析, 放在哪里都稳.
 */
const HOST_SCRIPT_NAME = 'nm-host.cjs'

/** 安装结果, 同时用作配置页的状态展示. */
export interface HostInstallStatus {
  /** 由扩展清单公钥派生的扩展 ID, 清单里的 allowed_origins 必须写它. */
  extensionId: string
  /** 扩展产物在数据目录里的绝对路径; 用户要在 chrome://extensions 里选中它. */
  extensionDir: string
  /** 扩展产物是否已就位. */
  extensionReady: boolean
  /** native messaging 清单的落地位置 (Windows 下是清单文件, 注册表项指向它). */
  manifestPath: string
  /** 清单是否已安装, 且内容与当前期望一致. */
  manifestReady: boolean
  /** 清单已存在但内容不符 (换了数据目录或换了密钥), 需要重装. */
  manifestStale: boolean
  /** 包装脚本路径, 即清单 path 指向的文件. */
  wrapperPath: string
  /** 包装脚本里写死的解释器绝对路径. */
  interpreter: string
  /** 真正需要用户手动完成的那一步的说明; 全部就绪时为空数组. */
  manualSteps: string[]
}

/** 判断当前宿主是不是 Electron. */
function isElectron(): boolean {
  return typeof process.versions['electron'] === 'string' && process.versions['electron'] !== ''
}

/**
 * 取解释器绝对路径.
 *
 * Electron 二进制在设置 `ELECTRON_RUN_AS_NODE=1` 之后行为等同 node, 所以这里仍然
 * 返回 `process.execPath`, 由包装脚本负责补那个环境变量.
 *
 * @returns 解释器的绝对路径.
 */
export function interpreterPath(): string {
  return process.execPath
}

/**
 * 取插件包根目录.
 *
 * 不能用"本文件向上两级"这种固定假设: 产物在 `lib/index.js` 时向上两级正好是包根,
 * 但从 `src/` 直接运行时(测试, 或开发者用 tsx 加载)就会算成 `src/`. 所以这里向上
 * 查找最近的 package.json, 两种布局都能得到正确的包根.
 *
 * @returns 包根目录绝对路径.
 * @throws 一路到文件系统根都没找到 package.json 时抛出.
 */
export function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(`从 ${import.meta.url} 向上找不到 package.json, 无法定位插件包根目录`)
    }
    directory = parent
  }
}

/** 插件包内随包分发的扩展产物目录. */
export function bundledExtensionDir(): string {
  return join(packageRoot(), 'assets', 'extension')
}

/** 插件包内随包分发的宿主脚本路径. */
export function bundledHostScript(): string {
  return join(packageRoot(), 'lib', HOST_SCRIPT_NAME)
}

/**
 * 按平台给出 native messaging 清单目录.
 *
 * 这里只支持 Google Chrome (用户明确的选择), 因此每个平台只有一条路径;
 * Chromium / Edge / Brave 各自另有目录, 不在本插件的范围内.
 *
 * 注意 `homedir()` 在 macOS 上取自账户数据库而不是 $HOME, 所以测试改 HOME 是隔离
 * 不了这个目录的; 需要隔离时用 {@link HostInstallOptions.manifestDir} 显式传入.
 *
 * @returns 清单目录绝对路径; Windows 不使用文件目录, 返回 null.
 */
export function nativeMessagingDir(): string | null {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
  }
  if (process.platform === 'win32') return null
  return join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts')
}

/**
 * 安装与检查的可选覆盖项.
 *
 * 存在的意义是给出一个不碰真实用户目录的接缝: 清单落在 Chrome 的固定目录, 而那个
 * 目录在 macOS 上由账户数据库决定, 测试无法靠改环境变量隔离.
 */
export interface HostInstallOptions {
  /** 覆盖清单目录; 传 null 表示走 Windows 的注册表路径. */
  manifestDir?: string | null
  /** 覆盖随包分发的扩展产物目录. */
  bundledExtensionDir?: string
  /** 覆盖随包分发的宿主脚本路径. */
  bundledHostScript?: string
}

/** 解析实际使用的清单目录. */
function manifestDirOf(options: HostInstallOptions): string | null {
  return options.manifestDir !== undefined ? options.manifestDir : nativeMessagingDir()
}

/**
 * 解析实际使用的扩展产物目录.
 * @param paths 解析后的路径集合 (用于在缺省时回落到数据目录旁的随包位置).
 * @param options 可选覆盖项.
 * @returns 扩展产物目录.
 */
function extensionBundleDirOf(paths: ResolvedPaths, options: HostInstallOptions): string {
  void paths
  return options.bundledExtensionDir ?? bundledExtensionDir()
}

/**
 * 从扩展清单的 key 字段派生扩展 ID.
 *
 * Chrome 的算法: 取公钥 DER 编码的 SHA-256 前 16 字节, 每个 nibble 映射到 a-p.
 * 之所以要自己算而不是让 Chrome 告诉我们: 清单里的 allowed_origins 必须先把 ID
 * 写死, 这是一个先有鸡还是先有蛋的问题, 只能自己算.
 *
 * @param manifestKeyBase64 扩展清单里的 key 字段值.
 * @returns 32 字符的扩展 ID.
 */
export function extensionIdFromKey(manifestKeyBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(manifestKeyBase64, 'base64')).digest()
  let id = ''
  for (let i = 0; i < 16; i += 1) {
    id += String.fromCharCode(97 + (digest[i]! >> 4))
    id += String.fromCharCode(97 + (digest[i]! & 0x0f))
  }
  return id
}

/**
 * 读插件自带扩展清单, 取出 key 字段并算出扩展 ID.
 * @param extensionDir 随包分发的扩展产物目录.
 * @returns 扩展 ID.
 */
async function readBundledExtensionId(extensionDir: string): Promise<string> {
  const manifestPath = join(extensionDir, 'manifest.json')
  let text: string
  try {
    text = await readFile(manifestPath, 'utf8')
  } catch (error) {
    throw new Error(`找不到随包分发的扩展清单 ${manifestPath}: 插件包可能不完整`, { cause: error })
  }
  const manifest = JSON.parse(text) as Record<string, unknown>
  const key = manifest[MANIFEST_KEY_FIELD]
  if (typeof key !== 'string' || key === '') {
    throw new Error(
      `${manifestPath} 缺少 key 字段. 没有它, 未打包扩展的 ID 会随目录路径漂移, `
      + 'native messaging 清单里的 allowed_origins 会立刻失配.',
    )
  }
  return extensionIdFromKey(key)
}

/**
 * 把产物目录同步到目标目录 (只处理普通文件与目录, 不跟随符号链接).
 *
 * 刻意做成"同步"而不是"先删后拷": 目标目录正是 Chrome 已经加载的那个扩展目录, 整个
 * 删掉会让浏览器里的扩展一瞬间变成无效条目 (文件不存在), 用户得重新加载一次. 逐文件
 * 覆盖则文件始终在位, 用户只需在 chrome://extensions 点一下 reload.
 *
 * 同时清理目标里源已不存在的条目, 否则改名或删除文件后会在目标里留下过期残留, 而那
 * 种残留会让 Chrome 加载到新旧混合的产物.
 *
 * @param from 源目录.
 * @param to 目标目录.
 */
async function syncTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  const entries = await readdir(from, { withFileTypes: true })
  const sourceNames = new Set(entries.map(entry => entry.name))
  for (const existing of await readdir(to, { withFileTypes: true })) {
    if (sourceNames.has(existing.name)) continue
    await rm(join(to, existing.name), { recursive: true, force: true })
  }
  for (const entry of entries) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      await syncTree(source, target)
    } else if (entry.isFile()) {
      await copyFile(source, target)
    }
  }
}

/** 生成包装脚本内容. */
function wrapperContent(hostScript: string, rendezvousFile: string): string {
  const interpreter = interpreterPath()
  if (process.platform === 'win32') {
    const lines = ['@echo off']
    if (isElectron()) lines.push('set ELECTRON_RUN_AS_NODE=1')
    lines.push(`"${interpreter}" "${hostScript}" "${rendezvousFile}"`)
    return `${lines.join('\r\n')}\r\n`
  }
  const lines = ['#!/bin/sh']
  lines.push('# 由 dsh-browser 生成, 请勿手工编辑; 重新安装会覆盖本文件.')
  lines.push('# Chrome 直接 exec 本脚本, 所以解释器必须用绝对路径, 不能依赖 PATH.')
  if (isElectron()) {
    // 环境变量必须先 export 再 exec.
    // 不能写成 `exec ELECTRON_RUN_AS_NODE=1 "interpreter" ...`: POSIX sh 的 exec
    // 不接受这种前缀赋值, 实测会得到 `exec: ELECTRON_RUN_AS_NODE=1: not found`
    // 并以 127 退出 —— 现象是扩展一直连不上, 而 Chrome 那边只说 host 退出了.
    lines.push('ELECTRON_RUN_AS_NODE=1')
    lines.push('export ELECTRON_RUN_AS_NODE')
  }
  // exec 让 node 进程顶替 shell, 于是 Chrome 的管道直接连到 node 的 stdio.
  lines.push(`exec "${interpreter}" "${hostScript}" "${rendezvousFile}"`)
  return `${lines.join('\n')}\n`
}

/** 生成 native messaging 清单内容. */
function manifestContent(extensionId: string, wrapperPath: string): string {
  return `${JSON.stringify({
    name: NATIVE_HOST_NAME,
    description: 'dsh-browser 的 native messaging host: 在扩展与 dsh 之间搬运消息.',
    path: wrapperPath,
    type: 'stdio',
    // 只有这一个扩展 ID 能启动本 host; 别处加载的同名扩展一律拒绝.
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2)}\n`
}

/** 判断文件是否存在. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 在 Windows 上把清单写进注册表.
 *
 * Windows 的 native messaging 不是放文件, 而是把一个注册表项指向清单文件. 这一步
 * 不需要管理员权限: 写的是当前用户分支 HKCU.
 *
 * @param manifestPath 清单文件绝对路径.
 * @returns 注册是否成功.
 */
async function registerWindowsHost(manifestPath: string): Promise<{ ok: boolean, detail: string }> {
  const { execFile } = await import('node:child_process')
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  return new Promise((resolve) => {
    execFile('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], (error, _stdout, stderr) => {
      if (error !== null && error !== undefined) {
        resolve({ ok: false, detail: `reg add 失败: ${stderr || String(error)}` })
        return
      }
      resolve({ ok: true, detail: key })
    })
  })
}

/** 卸载 Windows 上的注册表项. */
async function unregisterWindowsHost(): Promise<void> {
  const { execFile } = await import('node:child_process')
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  await new Promise<void>((resolve) => {
    execFile('reg', ['delete', key, '/f'], () => { resolve() })
  })
}

/**
 * 查询当前安装状态, 不做任何写入.
 *
 * @param paths 解析后的路径集合.
 * @param options 可选覆盖项 (测试用接缝).
 * @returns 状态报告, 含仍需用户手动完成的步骤.
 */
export async function inspectHost(paths: ResolvedPaths, options: HostInstallOptions = {}): Promise<HostInstallStatus> {
  const extensionId = await readBundledExtensionId(extensionBundleDirOf(paths, options))
  const manifestDir = manifestDirOf(options)
  const manifestPath = manifestDir === null
    ? join(paths.hostDir, `${NATIVE_HOST_NAME}.json`)
    : join(manifestDir, `${NATIVE_HOST_NAME}.json`)
  const wrapperPath = join(paths.hostDir, WRAPPER_NAME)

  const extensionReady = await exists(join(paths.extensionDir, 'manifest.json'))
  const wrapperReady = await exists(wrapperPath)
  const expectedManifest = manifestContent(extensionId, wrapperPath)

  let manifestReady = false
  let manifestStale = false
  if (manifestDir === null) {
    // Windows: 清单文件 + 注册表项都要在. 注册表查询用 reg query, 输出匹配值数据.
    const fileExists = await exists(manifestPath)
    if (fileExists) {
      const actual = await readFile(manifestPath, 'utf8').catch(() => '')
      manifestReady = actual === expectedManifest && await windowsRegistryPointsAt(manifestPath)
      manifestStale = !manifestReady
    }
  } else if (await exists(manifestPath)) {
    const actual = await readFile(manifestPath, 'utf8').catch(() => '')
    manifestReady = actual === expectedManifest
    manifestStale = !manifestReady
  }

  const manualSteps: string[] = []
  if (!extensionReady) {
    manualSteps.push('扩展产物还没有落到数据目录, 请先点"安装连接组件".')
  } else if (!manifestReady || !wrapperReady) {
    manualSteps.push('连接组件还没有装好, 请点"安装连接组件".')
  } else {
    manualSteps.push(
      `在 chrome://extensions 打开开发者模式, 点"加载已解压的扩展程序", 选中 ${paths.extensionDir}.`,
      '装好后回到这里刷新状态, 扩展会自动通过 native messaging 连上来.',
    )
  }

  return {
    extensionId,
    extensionDir: paths.extensionDir,
    extensionReady,
    manifestPath,
    manifestReady: manifestReady && wrapperReady,
    manifestStale,
    wrapperPath,
    interpreter: interpreterPath(),
    manualSteps,
  }
}

/** 查 Windows 注册表项是否指向给定清单. */
async function windowsRegistryPointsAt(manifestPath: string): Promise<boolean> {
  const { execFile } = await import('node:child_process')
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], (error, stdout) => {
      if (error !== null && error !== undefined) {
        resolve(false)
        return
      }
      resolve(stdout.includes(manifestPath))
    })
  })
}

/**
 * 安装连接组件: 落扩展产物, 落宿主脚本, 写包装脚本与清单.
 *
 * 整个操作是幂等的, 重复执行只会覆盖同一批文件, 不会留下第二份.
 *
 * @param paths 解析后的路径集合.
 * @param options 可选覆盖项 (测试用接缝).
 * @returns 安装后的状态.
 */
export async function installHost(paths: ResolvedPaths, options: HostInstallOptions = {}): Promise<HostInstallStatus> {
  // 1. 扩展产物落到数据目录. 先清掉旧目录, 避免上一次构建的残留文件混在里面
  //    让用户加载到过期的扩展.
  const bundledExtension = extensionBundleDirOf(paths, options)
  if (!await exists(join(bundledExtension, 'manifest.json'))) {
    throw new Error(`插件包内没有扩展产物 ${bundledExtension}; 请先执行构建`)
  }
  // 同步而不是重建: 这个目录就是 Chrome 正在加载的那个扩展目录.
  await syncTree(bundledExtension, paths.extensionDir)

  // 2. 宿主脚本与包装脚本. 包装脚本里写死解释器绝对路径与会合文件路径.
  await mkdir(paths.hostDir, { recursive: true })
  const hostScriptTarget = join(paths.hostDir, HOST_SCRIPT_NAME)
  await copyFile(options.bundledHostScript ?? bundledHostScript(), hostScriptTarget)
  const wrapperPath = join(paths.hostDir, WRAPPER_NAME)
  await writeFile(wrapperPath, wrapperContent(hostScriptTarget, paths.rendezvousFile), 'utf8')
  if (process.platform !== 'win32') {
    await chmod(wrapperPath, 0o755)
    await chmod(hostScriptTarget, 0o644)
  }

  // 3. 清单. Windows 走注册表, 其余平台写文件.
  const extensionId = await readBundledExtensionId(bundledExtension)
  const manifestDir = manifestDirOf(options)
  const manifestPath = manifestDir === null
    ? join(paths.hostDir, `${NATIVE_HOST_NAME}.json`)
    : join(manifestDir, `${NATIVE_HOST_NAME}.json`)
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, manifestContent(extensionId, wrapperPath), 'utf8')
  if (manifestDir === null) {
    const registered = await registerWindowsHost(manifestPath)
    if (!registered.ok) throw new Error(`Windows 注册 native messaging host 失败: ${registered.detail}`)
  }

  return inspectHost(paths, options)
}

/**
 * 卸载连接组件: 删掉清单与包装脚本.
 *
 * 扩展产物目录保留: 用户可能已经在 Chrome 里加载过它, 删掉会让扩展变成无效条目.
 *
 * @param paths 解析后的路径集合.
 * @param options 可选覆盖项 (测试用接缝).
 */
export async function uninstallHost(paths: ResolvedPaths, options: HostInstallOptions = {}): Promise<void> {
  const manifestDir = manifestDirOf(options)
  const manifestPath = manifestDir === null
    ? join(paths.hostDir, `${NATIVE_HOST_NAME}.json`)
    : join(manifestDir, `${NATIVE_HOST_NAME}.json`)
  await rm(manifestPath, { force: true })
  if (manifestDir === null) await unregisterWindowsHost()
  await rm(join(paths.hostDir, WRAPPER_NAME), { force: true })
  await rm(join(paths.hostDir, HOST_SCRIPT_NAME), { force: true })
}
