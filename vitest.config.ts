/**
 * 测试配置.
 *
 * 只收 `tests/` 下的文件: `.tmp/` 是临时工作区, 里面可能有开发中随手写的脚本,
 * 让 vitest 扫到它们会让 `pnpm test` 的结果不稳定.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
  },
})
