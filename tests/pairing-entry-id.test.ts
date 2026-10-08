/**
 * 配置表单的条目 id 必须与 bundle patch 一致.
 *
 * 这是那个"根本没地方填"的问题的根源: 设置表单按 **profile 条目 id** 寻址, 而不是按包名,
 * 而且两者不一致时**不会报错** —— 界面一切正常, 只是那张卡上没有配置区. 官方文档把这一点
 * 单独拎出来警告过, 因为它是静默的.
 *
 * 所以我不能只在代码里写个常量就算完: 得有个东西在 `cordis.patch.yml` 的行 id 被改掉时把
 * 这件事喊出来. 这条测试就是它.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENTRY_ID, PACKAGE_NAME } from '../src/client/entry.ts'

/** 仓库根目录. */
const ROOT = join(import.meta.dirname, '..')

describe('配置表单的条目 id', () => {
  it('与 cordis.patch.yml 里插入的行 id 一致', () => {
    const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
    // 抓 insert 列表里的 - id: <名字>. 不引入 YAML 解析, 因为这里只需要认出一行.
    const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gmu)].map(match => match[1])
    expect(ids, 'cordis.patch.yml 里没找到插入行的 id').toContain(ENTRY_ID)
  })

  it('与 package.json 的包名一致 (本包只有一行, 两者相同)', () => {
    // 槽位的键是包名, 表单寻址是条目 id. 本包刻意让它们相同, 少一层要记的对应关系;
    // 若将来拆成多行, 这条会失败, 提醒改成按行寻址.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string }
    expect(manifest.name).toBe(ENTRY_ID)
    // 槽位的键也必须是包名, 否则卡片根本不渲染.
    expect(PACKAGE_NAME).toBe(manifest.name)
  })
})
