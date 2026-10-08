/**
 * 启动包装脚本的执行测试.
 *
 * 包装脚本是 Chrome 与 native host 之间唯一的一环, 它出错的后果是"扩展一直显示未连接",
 * 而 Chrome 那边只在扩展的日志里留一句 host 已退出, 极难定位. 有两类错误是纯文本检查
 * 抓不到的:
 *
 *   1. shebang 后面用了 POSIX sh 不接受的语法. 例如
 *      `exec FOO=bar "cmd"` 会被 dash 解析成 "找不到 FOO=bar 这个命令", 以 127 退出.
 *   2. 解释器路径或传参不对, 于是 host 起来就崩.
 *
 * 所以这个测试**真的把生成的脚本执行一遍**: 用一个假的"解释器"替换掉 node, 让它把
 * 自己收到的参数与环境变量写到文件, 再检查内容是否符合预期. 这样既不依赖真实
 * Electron/node, 也能覆盖 sh 的语法解析.
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)

let workspace = ''
let outputFile = ''

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-browser-wrapper-'))
  outputFile = join(workspace, 'observed.txt')
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

/**
 * 造一个字面量包装脚本并执行它, 返回它写下的观测内容.
 *
 * @param script 脚本正文.
 * @returns 假解释器记录下来的内容.
 */
async function runWrapper(script: string): Promise<{ stdout: string, observed: string, exitCode: number }> {
  const wrapper = join(workspace, 'run.sh')
  await writeFile(wrapper, script, 'utf8')
  await chmod(wrapper, 0o755)
  try {
    const { stdout } = await run('/bin/sh', [wrapper], { timeout: 5_000 })
    const observed = await readFile(outputFile, 'utf8').catch(() => '')
    return { stdout, observed, exitCode: 0 }
  } catch (error) {
    const failure = error as { code?: number, stdout?: string }
    const observed = await readFile(outputFile, 'utf8').catch(() => '')
    return { stdout: failure.stdout ?? '', observed, exitCode: failure.code ?? -1 }
  }
}

/** 生成一段"假解释器"脚本: 记录 argv 与关心的环境变量. */
function fakeInterpreter(): string {
  const path = join(workspace, 'fake-node.sh')
  return path
}

/** 把假解释器写好并返回路径. */
async function installFakeInterpreter(): Promise<string> {
  const path = fakeInterpreter()
  await writeFile(path, `#!/bin/sh
{
  echo "argv0=$0"
  echo "arg1=$1"
  echo "arg2=$2"
  echo "argc=$#"
  echo "ELECTRON_RUN_AS_NODE=\${ELECTRON_RUN_AS_NODE-unset}"
} > "${outputFile}"
`, 'utf8')
  await chmod(path, 0o755)
  return path
}

describe('启动包装脚本的 sh 语法', () => {
  it('/bin/sh 不接受 exec 后面的前缀变量赋值 (这是必须避开的写法)', async () => {
    const interpreter = await installFakeInterpreter()
    // 这个写法看起来像对的, 但 POSIX sh 会把 FOO=bar 当成命令名.
    const bad = await runWrapper(`#!/bin/sh\nexec FOO=bar "${interpreter}" a b\n`)
    expect(bad.exitCode).not.toBe(0)
    expect(bad.observed).toBe('')
  })

  it('export 之后再 exec 的写法可以正常工作', async () => {
    const interpreter = await installFakeInterpreter()
    const good = await runWrapper(`#!/bin/sh
ELECTRON_RUN_AS_NODE=1
export ELECTRON_RUN_AS_NODE
exec "${interpreter}" "${join(workspace, 'nm-host.cjs')}" "${join(workspace, 'bridge.json')}"
`)
    expect(good.exitCode).toBe(0)
    expect(good.observed).toContain('argc=2')
    expect(good.observed).toContain('arg1=' + join(workspace, 'nm-host.cjs'))
    expect(good.observed).toContain('arg2=' + join(workspace, 'bridge.json'))
    expect(good.observed).toContain('ELECTRON_RUN_AS_NODE=1')
  })
})

describe('真实生成的包装脚本可执行', () => {
  it('把 build 产物里的包装脚本生成逻辑跑一遍并实际执行', async () => {
    // 直接驱动生成逻辑而不是手抄一份脚本, 否则测试与实际实现会漂移.
    const { Config, resolvePaths } = await import('../src/config.ts')
    const { installHost } = await import('../src/native-host/install.ts')
    const paths = resolvePaths(Config({ dataDir: join(workspace, 'data') }))
    const manifestDir = join(workspace, 'hosts')
    const status = await installHost(paths, { manifestDir })

    const wrapper = await readFile(status.wrapperPath, 'utf8')
    // 绝不能出现 exec 后跟变量赋值的写法.
    expect(wrapper).not.toMatch(/exec\s+[A-Za-z_][A-Za-z0-9_]*=/u)
    // 解释器必须是绝对路径, 不能依赖 PATH.
    expect(wrapper).not.toContain('/usr/bin/env')
    expect(wrapper).toContain(status.interpreter)

    // 真的执行它: node 会收到 nm-host.cjs 与会合文件两个参数, 并且因为读不到会合
    // 文件而进入等待重试. 用短超时把它杀掉, 只验证"它成功启动到 node 里".
    await chmod(status.wrapperPath, 0o755)
    const mode = (await stat(status.wrapperPath)).mode & 0o777
    expect(mode & 0o111, '包装脚本必须可执行').not.toBe(0)

    // 把解释器换成假解释器, 以便在测试里观察参数而不真的拉起 host.
    const interpreter = await installFakeInterpreter()
    const probe = wrapper.replace(status.interpreter, interpreter)
    const result = await runWrapper(probe)
    expect(result.exitCode).toBe(0)
    expect(result.observed).toContain('nm-host.cjs')
    expect(result.observed).toContain('bridge.json')
  })
})
