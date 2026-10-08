/**
 * 浏览器求值的页面侧代码.
 *
 * 这段代码是以**字符串**形式送进浏览器的, 类型系统完全管不到它: 拼错一个引号, 漏一个
 * 分号, 或者序列化逻辑写错, 都不会在编译期报错, 只会变成用户浏览器里一句难以定位的
 * "页面里的表达式抛错了".
 *
 * 所以这里把它当被测对象而不是黑盒: 直接跑生成的代码, 检查它真的能产出预期结果, 并且
 * 把页面里那些无法跨进程序列化的值 (函数, DOM 节点, 循环引用, bigint) 都收敛成字符串.
 */

import { beforeAll, describe, expect, it } from 'vitest'

/** 生成代码的类型, 与实现保持一致. */
type BuildEvaluate = (expression: string) => string

let buildEvaluateCode: BuildEvaluate

beforeAll(async () => {
  // 直接 import 会连带拉起 chrome 相关的模块依赖, 这里只需要这一个纯函数.
  const module = await import('../extension/src/background/evaluate.ts')
  buildEvaluateCode = module.buildEvaluateCode
})

/** 在"页面"里跑一段生成的代码. */
async function run(expression: string): Promise<{ value: string, truncated: boolean, valueType: string }> {
  const code = buildEvaluateCode(expression)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 被测对象本身就是一段要执行的代码字符串.
  const factory = new Function(`return (${code})`) as () => Promise<{ value: string, truncated: boolean, valueType: string }>
  return factory()
}

beforeAll(() => {
  // 生成代码里的 describeNode 会用 `instanceof Node` 判断 DOM 节点; Node 环境没有它,
  // 而序列化普通对象时也会走到那一次判断, 所以必须提供一个.
  const globalStub = globalThis as unknown as Record<string, unknown>
  globalStub['Node'] = class {}
})

describe('生成的求值代码', () => {
  it('是合法 JS, 并且把表达式的结果序列化成字符串', async () => {
    const result = await run('1 + 1')
    expect(result.value).toBe('2')
    expect(result.valueType).toBe('number')
    expect(result.truncated).toBe(false)
  })

  it('支持 await', async () => {
    const result = await run('await Promise.resolve("已就绪")')
    expect(JSON.parse(result.value)).toBe('已就绪')
    expect(result.valueType).toBe('string')
  })

  it('对象序列化成可读 JSON, 并带上真实类型', async () => {
    const result = await run('({ a: 1, b: [1, 2] })')
    expect(JSON.parse(result.value)).toEqual({ a: 1, b: [1, 2] })
    expect(result.valueType).toBe('object')
  })

  it('数组的类型是 array 而不是 object', async () => {
    const result = await run('[1, 2, 3]')
    expect(result.valueType).toBe('array')
  })

  it('null 不会被误报成 object', async () => {
    const result = await run('null')
    expect(result.value).toBe('null')
    expect(result.valueType).toBe('null')
  })

  it('把无法跨进程序列化的值收敛成字符串', async () => {
    // 这几种值如果原样返回, 会直接让结果过不了 JSON 边界 —— 与其在宿主侧猜, 不如在页面
    // 里就把它们说清楚.
    const result = await run('({ fn: function named() {}, undef: undefined, big: 10n, sym: Symbol("s") })')
    const parsed = JSON.parse(result.value) as Record<string, string>
    expect(parsed['fn']).toBe('[Function named]')
    expect(parsed['undef']).toBe('[undefined]')
    expect(parsed['big']).toBe('10n')
    expect(parsed['sym']).toContain('Symbol(s)')
  })

  it('循环引用不会让序列化崩掉', async () => {
    const result = await run('(() => { const a = {}; a.self = a; return a })()')
    expect(result.value).toContain('[循环引用]')
  })

  it('嵌套过深时截断并如实标记', async () => {
    const result = await run('(() => { let node = {}; const root = node; for (let i = 0; i < 10; i += 1) { node.next = {}; node = node.next } return root })()')
    expect(result.value).toContain('已达最大深度')
    expect(result.truncated).toBe(true)
  })

  it('超长字符串会截断而不是撑爆上下文', async () => {
    const result = await run('"x".repeat(5000)')
    expect(result.truncated).toBe(true)
    expect(result.value.length).toBeLessThan(3_000)
  })

  it('表达式抛错时让错误冒出去, 而不是伪装成结果', async () => {
    // 页面侧不该把异常吞掉: 模型需要看到真实原因才能改表达式.
    await expect(run('(() => { throw new Error("boom") })()')).rejects.toThrow('boom')
  })
})
