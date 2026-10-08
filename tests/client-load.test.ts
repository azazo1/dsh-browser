/**
 * Client bundle 的加载演练.
 *
 * 这个仓库最容易被漏掉的一环: Host 半区在 dsh 里加载成功, 并不意味着浏览器半区能用.
 * Client bundle 只有在**页面真正打开**时才被求值, 所以"dsh 起来了, 日志干净"完全可能
 * 掩盖一个会让插件在设置页里整个消失的错误.
 *
 * 这里就补上这一步: 把构建产物 lib/client.js 放进一个最小的浏览器壳子里求值 ——
 * 提供 __ModuleLoader__ 与 require 桩, 然后按 Loader 的方式调用它导出的 apply(ctx),
 * 用真实的 cordis Context 加 locale / slots 两个服务. apply 里任何一次 throw 都会
 * 在这里暴露成测试失败, 而不是等到用户在页面上看见 "entry did not activate".
 */

import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

/** 构建产物路径. */
const BUNDLE = join(import.meta.dirname, '..', 'lib', 'client.js')

/** __ModuleLoader__.load 收到的一次注册. */
interface Registration {
  id: string
  /**
   * 工厂函数.
   * @param require 模块解析桩.
   * @returns 插件模块导出.
   */
  factory: (require: (name: string) => unknown) => unknown
}

/** 被记录下来的注册. */
let loaded: Registration | undefined

/** 记录对 slots.register 的调用, 便于断言注册参数. */
interface SlotRegisterCall {
  options: Record<string, unknown>
  component: unknown
}

/** 上一次 mount 期间发生的 slots.register 调用. */
let slotCalls: SlotRegisterCall[] = []

/** 上一次 mount 期间发生的 locale.register 调用. */
let localeRegistrations: { namespace: string, dictionaries: Record<string, Record<string, string>> }[] = []

/** 已被"父级"声明的槽位. */
let declaredSlots = new Set<string>()

/** 已注册的槽位条目 (去重用). */
let registeredSlots = new Set<string>()

/** 因槽位尚未声明而挂起的注册. */
let pendingInjections: { name: string, run: () => () => void }[] = []

/**
 * 模拟父级声明一个槽位, 并触发此前挂起的注册.
 *
 * @param name slot 名.
 */
function declareSlot(name: string): void {
  declaredSlots.add(name)
  const ready = pendingInjections.filter(pending => pending.name === name)
  pendingInjections = pendingInjections.filter(pending => pending.name !== name)
  for (const pending of ready) pending.run()
}

/** 模块解析桩: 只提供 bundle 声明为 external 的那几个. */
function stubRequire(name: string): unknown {
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (factory: unknown) => factory,
    useRef: (initial: unknown) => ({ current: initial }),
  }
  if (name === 'react') return react
  if (name === 'react/jsx-runtime') {
    return {
      jsx: (type: unknown, props: unknown, key: unknown) => ({ type, props, key }),
      jsxs: (type: unknown, props: unknown, key: unknown) => ({ type, props, key }),
      Fragment: Symbol('Fragment'),
    }
  }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    // 组件只需要可被当作 JSX 元素类型使用; 返回占位组件即可.
    const stub = (props: unknown) => ({ type: 'stub', props })
    return {
      Button: stub,
      Input: stub,
      StateDot: stub,
      Switch: stub,
      SettingsForm: stub,
      SettingsValueField: stub,
      // 表单模型与字段规格在 apply 期间就会被构造, 所以桩必须真的提供它们.
      // 这里只实现"够 apply 跑通"的最小行为: 本组测试关心的是加载演练 (见文件头),
      // 表单编辑语义由 tests/checks.test.ts 与 tests/pairing-entry-id.test.ts 覆盖.
      settingsTextField: (field: string) => ({
        field,
        format: (value: unknown) => (typeof value === 'string' ? value : ''),
        parse: (text: string) => (text === '' ? { kind: 'clear' } : { kind: 'set', value: text }),
      }),
      SettingsFormModel: class {
        /**
         * @param scope 表单作用域.
         * @param specs 字段规格.
         */
        constructor(private readonly scope: unknown, private readonly specs: unknown[]) { void scope; void specs }

        /**
         * 绑定一个投影.
         * @param project 投影函数.
         * @returns 只提供 getSnapshot 的快照存储桩.
         */
        bind(project: () => unknown): unknown { return { getSnapshot: project } }

        /**
         * 卡片级状态.
         * @returns 最小状态.
         */
        shell(): unknown { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false } }

        /**
         * 单字段状态.
         * @returns 最小状态.
         */
        field(): unknown { return { text: '', overridden: false, invalid: false } }

        /**
         * 表单动作.
         * @returns 空动作.
         */
        actions(): unknown { return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} } }

        /** 释放订阅. */
        dispose(): void {}
      },
    }
  }
  throw new Error(`演练壳子没有为 ${name} 提供桩; 该模块应当被声明为 external 或内联`)
}

/** 把产物求值一遍, 取出它注册的 factory. */
function evaluateBundle(): Registration {
  loaded = undefined
  const text = readFileSync(BUNDLE, 'utf8')
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration: Registration) => { loaded = registration },
      },
    },
  }
  // 用 Function 而不是 eval: 让 bundle 里的 window 指向壳子, 而不是 Node 全局.
  const run = new Function('window', 'require', text)
  run(sandbox.window, stubRequire)
  if (loaded === undefined) {
    throw new Error('bundle 没有调用 window.__ModuleLoader__.load')
  }
  return loaded
}

/**
 * 造一个带 locale / slots 桩的 cordis Context.
 *
 * 用真的 Context 而不是手写对象: apply 接收的 ctx 就是 cordis Context, 它的服务访问
 * 语义 (已注入才能取) 本身就是可能出错的地方, 手写对象会把这类错误掩盖掉.
 *
 * @returns 上下文与清理函数.
 */
function makeContext(): { ctx: Context, dispose: () => void } {
  const ctx = new Context()
  ctx.provide('locale', {
    /**
     * 绑定一个命名空间的翻译函数.
     * @returns 翻译函数.
     */
    bind: (namespace: string) => (key: string) => `${namespace}:${key}`,
    /**
     * 注册字典.
     * @param namespace 命名空间.
     * @param dictionaries 各语言的字典.
     * @returns 卸载函数.
     */
    register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {}
    },
  })
  // configForms: 配对令牌的表单靠它拿共享表单. 这里给一个最小可用的作用域 (只读快照 + 空订阅),
  // 因为本组测试关心的是"apply 能不能跑通", 而不是表单编辑本身 (那由 checks 与 pairing 两组覆盖).
  ctx.provide('configForms', {
    /**
     * 取某个条目 id 的表单作用域.
     * @param _id 条目 id.
     * @returns 只读的表单作用域桩.
     */
    get: (_id: string) => ({
      getSnapshot: () => ({
        status: 'ready',
        value: {},
        base: {},
        user: {},
        writable: true,
        revision: 1,
      }),
      subscribe: () => () => {},
      mutate: async () => true,
    }),
    /**
     * 只在条目被服务时执行注册回调; 桩里直接执行.
     * @param ids 条目 id 列表.
     * @param register 注册回调.
     * @returns 注册结果的取消函数.
     */
    whileServed: (ids: readonly string[], register: (served: Set<string>) => (() => void) | void) => {
      void ids
      return register(new Set(ids)) ?? (() => {})
    },
  })

  ctx.provide('slots', {
    /**
     * 注册一个 slot 条目.
     *
     * 这个桩**刻意复刻真实 registry 的两条硬规则**, 因为放宽它们就等于把最容易踩的
     * 坑挡在测试之外:
     *   1. 槽位必须先被父级声明过 (真实实现读 records 里的 spec), 否则抛错;
     *   2. 同一个 keyed 槽位在同一 key 上不能重复注册.
     *
     * 之前这个桩只是一句 no-op, 于是 `ctx.slots.register` 直接调用 (少了
     * `slots.inject`) 在测试里毫无问题, 到浏览器里却让整个插件 failed.
     *
     * @param options 注册选项.
     * @param component 组件.
     * @returns 卸载函数.
     */
    register: (options: Record<string, unknown>, component: unknown) => {
      const name = String(options['name'])
      if (!declaredSlots.has(name)) {
        throw new Error(`slot "${name}" is not declared (a parent entry's children table must declare it)`)
      }
      const key = options['key']
      const dedupe = key === undefined ? name : `${name}#${String(key)}`
      if (registeredSlots.has(dedupe)) {
        throw new Error(`keyed slot "${name}" already has an entry for key "${String(key)}"`)
      }
      registeredSlots.add(dedupe)
      slotCalls.push({ options, component })
      return () => { registeredSlots.delete(dedupe) }
    },
    /**
     * 等槽位被声明后再执行注册回调.
     *
     * 真实实现会持续监听声明变化; 桩里在声明已存在时立即回调, 否则记录一条待办,
     * 由测试在"声明"之后触发. 这样测试可以显式控制顺序, 从而验证插件不依赖顺序.
     *
     * @param name slot 名.
     * @param register 注册回调.
     * @returns 卸载函数.
     */
    inject: (name: string, register: () => () => void) => {
      if (declaredSlots.has(name)) {
        return register()
      }
      pendingInjections.push({ name, run: register })
      return () => {
        const index = pendingInjections.findIndex(pending => pending.run === register)
        if (index >= 0) pendingInjections.splice(index, 1)
      }
    },
  })
  return { ctx, dispose: () => {} }
}

beforeEach(() => {
  slotCalls = []
  localeRegistrations = []
  // 默认不预声明任何槽位: 现实里 apply 跑的时候父级页面是否已经声明由加载顺序决定,
  // 插件必须两种顺序都能活.
  declaredSlots = new Set()
  registeredSlots = new Set()
  pendingInjections = []
})

describe('Client bundle 的加载演练', () => {
  it('产物以正确的 id 注册自己', () => {
    const registration = evaluateBundle()
    // id 必须与 package.json 的 name 完全一致, 否则 Client 半区会静默缺席 boot graph.
    expect(registration.id).toBe('dsh-browser')
    expect(typeof registration.factory).toBe('function')
  })

  it('factory 能产出 inject 与 apply', () => {
    const registration = evaluateBundle()
    const module = registration.factory(stubRequire) as { inject?: unknown, apply?: unknown }
    expect(Array.isArray(module.inject)).toBe(true)
    expect(typeof module.apply).toBe('function')
    // slots 是注册设置页的必要服务.
    expect(module.inject).toContain('slots')
    expect(module.inject).toContain('locale')
  })

  it('父级先声明槽位时: apply 不抛错, 并注册了设置页, 会话 Tab 与字典', () => {
    declareSlot('plugins.bundle.config')
    declareSlot('conversation.view')
    const registration = evaluateBundle()
    const module = registration.factory(stubRequire) as { apply: (ctx: Context) => void }
    const { ctx, dispose } = makeContext()
    try {
      // 关键断言: 用户在页面上看到的 "entry did not activate" 就是这一步抛了.
      expect(() => { module.apply(ctx) }).not.toThrow()
    } finally {
      dispose()
    }
    assertRegistrationShape()
  })

  it('父级还没声明槽位时: apply 不抛错, 声明一到就补上注册', () => {
    // 这个顺序才是浏览器里实际常见的情况: 自己的模块可能比插件管理页先 apply.
    // 少了 slots.inject 的写法会在这里抛 "slot ... is not declared".
    const registration = evaluateBundle()
    const module = registration.factory(stubRequire) as { apply: (ctx: Context) => void }
    const { ctx, dispose } = makeContext()
    try {
      expect(() => { module.apply(ctx) }).not.toThrow()
      // 此时还不该有注册 (槽位未声明).
      expect(slotCalls).toHaveLength(0)
      declareSlot('plugins.bundle.config')
      expect(slotCalls).toHaveLength(1)
      declareSlot('conversation.view')
    } finally {
      dispose()
    }
    assertRegistrationShape()
  })

  it('inject 面里的 t 函数可用', () => {
    declareSlot('plugins.bundle.config')
    declareSlot('conversation.view')
    const registration = evaluateBundle()
    const module = registration.factory(stubRequire) as { apply: (ctx: Context) => void }
    const { ctx, dispose } = makeContext()
    try {
      module.apply(ctx)
    } finally {
      dispose()
    }
    const settings = slotCalls.find(call => call.options['name'] === 'plugins.bundle.config')
    const inject = settings?.options['inject'] as (() => { t: (key: string) => string }) | undefined
    expect(typeof inject).toBe('function')
    const face = inject?.()
    expect(typeof face?.t).toBe('function')
    expect(face?.t('title')).toBe('settings.dsh-browser:title')
  })
})

/**
 * 找到某个槽位的注册.
 *
 * @param name 槽位名.
 * @returns 对应的一次注册.
 */
function slotNamed(name: string): SlotRegisterCall | undefined {
  return slotCalls.find(call => call.options['name'] === name)
}

/**
 * 断言某份字典中英键集一致.
 *
 * @param namespace 命名空间.
 */
function assertDictionary(namespace: string): void {
  const registration = localeRegistrations.find(item => item.namespace === namespace)
  expect(registration, `缺少 ${namespace} 字典`).toBeDefined()
  const dictionaries = registration?.dictionaries ?? {}
  expect(Object.keys(dictionaries['zh'] ?? {}).length).toBeGreaterThan(0)
  expect(Object.keys(dictionaries['zh'] ?? {}).sort()).toEqual(Object.keys(dictionaries['en'] ?? {}).sort())
}

/** 断言设置页, 会话 Tab 与字典都按预期注册了. */
function assertRegistrationShape(): void {
  expect(localeRegistrations).toHaveLength(2)
  assertDictionary('settings.dsh-browser')
  assertDictionary('dsh-browser.tab')

  expect(slotCalls).toHaveLength(2)
  const settings = slotNamed('plugins.bundle.config')
  expect(settings?.options['key']).toBe('dsh-browser')
  expect(typeof settings?.component).toBe('function')

  const tab = slotNamed('conversation.view')
  expect(tab?.options['id']).toBe('dsh-browser')
  expect(typeof tab?.component).toBe('function')
}
