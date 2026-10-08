/**
 * native messaging 组件生成的测试.
 *
 * 这段代码是整条链路里最容易被忽略但一旦出错就完全不通的一环:
 *
 *   - 清单里的 path 必须指向一个**用绝对解释器路径**启动的包装脚本, 因为 Chrome
 *     直接 exec 它, 不经过 shell, 走不到 PATH 里的 node;
 *   - 清单里的 allowed_origins 必须是与扩展公钥相符的扩展 ID, 否则 Chrome 直接
 *     拒绝启动 host, 而扩展那边只看到"一直未连接";
 *   - 包装脚本必须有可执行位.
 *
 * 测试用临时 DSH_HOME 与临时 HOME, 不碰真实用户目录.
 */

import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, resolvePaths } from '../src/config.ts'
import { extensionIdFromKey, inspectHost, installHost, uninstallHost } from '../src/native-host/install.ts'

/** 由 extension/manifest.json 的 key 派生出的期望扩展 ID. */
const EXPECTED_EXTENSION_ID = 'hfbmjjcgbobkpmmkhfjgebcojhjpdokd'

let fakeHome = ''
let savedHome: string | undefined
let savedDshHome: string | undefined

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), 'dsh-browser-test-'))
  savedHome = process.env['HOME']
  savedDshHome = process.env['DSH_HOME']
  // 隔离两处路径来源, 保证测试不会写到真实用户目录.
  process.env['HOME'] = fakeHome
  process.env['DSH_HOME'] = join(fakeHome, '.dsh')
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = savedHome
  if (savedDshHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedDshHome
  await rm(fakeHome, { recursive: true, force: true })
})

/** 用默认配置解析路径. */
function paths(): ReturnType<typeof resolvePaths> {
  return resolvePaths(Config({}))
}

/**
 * 本次测试的覆盖项: 清单写进临时目录, 绝不碰真实的 Chrome NativeMessagingHosts.
 *
 * macOS 上 `homedir()` 取自账户数据库而不是 $HOME, 所以隔离只能靠这个显式接缝.
 */
function options(): { manifestDir: string } {
  return { manifestDir: join(fakeHome, 'nm-host-dir') }
}

describe('扩展 ID 派生', () => {
  it('按 Chrome 的算法从公钥算出稳定 ID', async () => {
    const manifest = JSON.parse(
      await readFile(join(import.meta.dirname, '..', 'assets', 'extension', 'manifest.json'), 'utf8'),
    ) as { key: string }
    expect(extensionIdFromKey(manifest.key)).toBe(EXPECTED_EXTENSION_ID)
  })

  it('ID 只由密钥决定, 与目录路径无关', () => {
    const key = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6JgVtSyjbMSxn1LpKDbLyyj47Y2eZJ5fYUwHyvKezb7VDyhT69c5cBg1pcu1Vx2qRgDlG4TZRswLc7I1XLE3sehivJy6LB4xlquAmN/U4na1/eSTeQ00QHLHC2YE7y3gW2yyIAuoal2Fz9OSwWkPqhV5Hx4VdIWcpVtKZOZSRc/+WuWhb+we+xbLtm2OZ/ztY5b3xi3TDJ2uZWtNbbnsrWR7KKZG/BXt+WfxFn9knRDQH4dGI6FTbUTeRJCTdnGMDSoWcKNNeh3G6a89QWXfeQxHX69q7np5Jbkv6r0k7AE/5QyRuHW1VMPHCcHJNVmP0/JiBu38D+pA5wifKKEhxwIDAQAB'
    expect(extensionIdFromKey(key)).toBe(EXPECTED_EXTENSION_ID)
  })
})

describe('native messaging 组件安装', () => {
  it('安装后清单, 包装脚本与扩展产物都就位', async () => {
    // 直接测真实包产物: 构建已产出 assets/extension 与 lib/nm-host.cjs.
    const resolved = paths()
    const status = await installHost(resolved, options())

    expect(status.extensionId).toBe(EXPECTED_EXTENSION_ID)
    expect(status.extensionReady).toBe(true)
    expect(status.manifestReady).toBe(true)
    expect(status.manifestStale).toBe(false)

    // 扩展产物确实被复制到了数据目录.
    const copiedManifest = await readFile(join(status.extensionDir, 'manifest.json'), 'utf8')
    expect(copiedManifest).toContain('"key"')

    // 清单内容: allowed_origins 必须精确写死我们的扩展 ID.
    const manifest = JSON.parse(await readFile(status.manifestPath, 'utf8')) as {
      name: string
      path: string
      type: string
      allowed_origins: string[]
    }
    expect(manifest.type).toBe('stdio')
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${EXPECTED_EXTENSION_ID}/`])
    expect(manifest.path).toBe(status.wrapperPath)
  })

  it('包装脚本写死解释器绝对路径并可执行', async () => {
    const status = await installHost(paths(), options())
    const wrapper = await readFile(status.wrapperPath, 'utf8')

    // 不能用 env node: Chrome 直接 exec, PATH 里没有用户装的 node.
    expect(wrapper).not.toContain('/usr/bin/env node')
    // 解释器路径必须是绝对的.
    expect(wrapper).toContain(process.execPath)
    // Electron 宿主需要这个环境变量才能当 node 用.
    if (process.versions['electron'] !== undefined) {
      expect(wrapper).toContain('ELECTRON_RUN_AS_NODE=1')
    }
    // 必须把会合文件路径传进去, host 靠它找到回连地址.
    expect(wrapper).toContain('bridge.json')
    // exec 让 node 顶替 shell, Chrome 的管道直接连到 node.
    expect(wrapper).toContain('exec ')

    if (process.platform !== 'win32') {
      const mode = (await stat(status.wrapperPath)).mode & 0o777
      expect(mode & 0o111, '包装脚本必须可执行').not.toBe(0)
    }
  })

  it('重复安装是幂等的, 不会留下第二份', async () => {
    const first = await installHost(paths(), options())
    const second = await installHost(paths(), options())
    expect(second.manifestPath).toBe(first.manifestPath)
    expect(second.wrapperPath).toBe(first.wrapperPath)
    expect(second.manifestReady).toBe(true)
  })

  it('换过密钥或目录后能被识别为过期', async () => {
    const resolved = paths()
    await installHost(resolved, options())
    const status = await inspectHost(resolved, options())
    expect(status.manifestReady).toBe(true)

    // 直接篡改清单内容, inspect 应当报告 stale.
    const manifest = JSON.parse(await readFile(status.manifestPath, 'utf8')) as { path: string }
    manifest.path = '/nonexistent/wrapper'
    await writeFile(status.manifestPath, JSON.stringify(manifest), 'utf8')
    const stale = await inspectHost(resolved, options())
    expect(stale.manifestReady).toBe(false)
    expect(stale.manifestStale).toBe(true)
  })

  it('卸载会移除清单与包装脚本, 但保留扩展产物', async () => {
    const resolved = paths()
    const status = await installHost(resolved, options())
    await uninstallHost(resolved, options())
    await expect(stat(status.manifestPath)).rejects.toThrow()
    await expect(stat(status.wrapperPath)).rejects.toThrow()
    // 扩展目录保留: 用户可能已经在 Chrome 里加载过它.
    await expect(stat(join(status.extensionDir, 'manifest.json'))).resolves.toBeDefined()
  })
})
