/**
 * console 输出的格式化.
 *
 * 守三件事: 空结果时把 note (含中断原因) 讲清楚; 条目按发生顺序排列且带级别与来源;
 * 超过 MAX_TEXT_CHARS 时从最旧的一端裁掉并注明省略条数.
 */

import { describe, expect, it } from 'vitest'
import { formatConsole } from '../src/tools/format.ts'
import type { ConsoleEntry, ConsoleReadResult } from '../shared/methods.ts'

/** 造一条 console 条目. */
function entry(overrides: Partial<ConsoleEntry> = {}): ConsoleEntry {
  return {
    seq: 1,
    level: 'log',
    type: 'log',
    text: 'hello',
    url: null,
    line: null,
    timestamp: 1,
    ...overrides,
  }
}

/** 造一次读取结果. */
function result(overrides: Partial<ConsoleReadResult> = {}): ConsoleReadResult {
  return {
    entries: [],
    capturing: false,
    interrupted: null,
    note: '返回 0 条',
    ...overrides,
  }
}

describe('formatConsole', () => {
  it('空结果输出 note, 中断时附原因与下一步', () => {
    const plain = formatConsole(result())
    expect(plain).toContain('没有新输出')
    expect(plain).toContain('返回 0 条')
    const interrupted = formatConsole(result({ interrupted: '用户点掉了"已开始调试此浏览器"提示条' }))
    expect(interrupted).toContain('提示条')
    expect(interrupted).toContain('action:"start"')
  })

  it('条目按发生顺序排列, 带级别与来源位置', () => {
    const text = formatConsole(result({
      entries: [
        entry({ seq: 1, level: 'log', text: 'first' }),
        entry({ seq: 2, level: 'error', text: 'boom', url: 'https://example.com/app.js', line: 12 }),
      ],
      note: '返回 2 条',
    }))
    const firstIndex = text.indexOf('[log] first')
    const secondIndex = text.indexOf('[error] boom (https://example.com/app.js:12)')
    expect(firstIndex).toBeGreaterThan(-1)
    expect(secondIndex).toBeGreaterThan(firstIndex)
  })

  it('other 级别带原始 type, 便于认出 dir/table 等展示命令', () => {
    const text = formatConsole(result({ entries: [entry({ level: 'other', type: 'table', text: '…' })] }))
    expect(text).toContain('[other] [table]')
  })

  it('超过总预算时从最旧的一端裁掉, 保留最新的', () => {
    // MAX_TEXT_CHARS 是 120_000; 每条 100 字符的话 2000 条必然超出.
    const entries: ConsoleEntry[] = Array.from({ length: 2000 }, (_unused, index) =>
      entry({ seq: index + 1, text: `line-${String(index)}-${'x'.repeat(80)}` }))
    const text = formatConsole(result({ entries, note: '返回 2000 条' }))
    expect(text).toContain('已省略最早的')
    // 最新的一条必须保留.
    expect(text).toContain('line-1999')
    // 最旧的一条被裁掉.
    expect(text).not.toContain('line-0-')
  })
})
