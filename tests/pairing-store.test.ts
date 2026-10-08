/**
 * 配对令牌本机存放的行为.
 *
 * 关键点只有一个: 令牌转移到数据目录文件之后, "已配置"的判断与文件内容一致,
 * 且手动改文件能被 reload 跟上 —— 否则用户换令牌时会出现两侧对不上的死局.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PairingTokenStore } from '../src/pairing-store.ts'

describe('PairingTokenStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const makeStore = () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-browser-pairing-'))
    dirs.push(dataDir)
    return new PairingTokenStore(() => dataDir)
  }

  it('没有令牌文件时报告未配置', () => {
    expect(makeStore().current()).toBe('')
  })

  it('store 落盘为 0600 并立刻生效', () => {
    const store = makeStore()
    store.store('token-a')
    expect(store.current()).toBe('token-a')
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
    expect(readFileSync(store.path, 'utf8').trim()).toBe('token-a')
  })

  it('reload 跟上手动改动', () => {
    const store = makeStore()
    store.store('token-a')
    writeFileSync(store.path, 'token-b\n')
    expect(store.current()).toBe('token-a')
    store.reload()
    expect(store.current()).toBe('token-b')
  })
})
