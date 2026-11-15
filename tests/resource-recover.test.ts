/**
 * 资源调用的自愈: 连接在"判定可用"之后、真正发送之前断掉.
 *
 * 现场是这样的: 浏览器没开, 调用 browser_open 时插件先看到一条瞬时连接, 判定"可以复用",
 * 于是没有启动浏览器; 等到真正发请求时那条连接已经没了, 得到的错误是 no-binding.
 *
 * 正确的处理不是猜连接活了多久, 而是利用 no-binding 的含义 —— 这一帧根本没发出去 ——
 * 重新走一遍选浏览器/启动/等待, 再把请求原样重试一次.
 */

import { describe, expect, it, vi } from 'vitest'
import { makeResource } from '../src/runtime.ts'

/** 造一个只关心 call 的桥桩. */
function bridgeOf(call: ReturnType<typeof vi.fn>): never {
  return { call } as never
}

/** 造一个带 no-binding 错误码的失败. */
function noBinding(): Error {
  return Object.assign(new Error('桥上没有连接'), { code: 'no-binding' })
}

describe('资源的 no-binding 自愈', () => {
  it('连接在发送前断掉时, 恢复一次并原样重试', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(noBinding())
      .mockResolvedValueOnce([{ id: 1 }])
    const recover = vi.fn(async () => {})
    const resource = makeResource({
      bridge: bridgeOf(call),
      assertGranted: () => {},
      recover,
      onClose: () => {},
    })

    await expect(resource.value.call('tabs.list', {}, new AbortController().signal))
      .resolves.toEqual([{ id: 1 }])
    // 没有这次重试, 调用方拿到的就只是一句"扩展没连着 dsh".
    expect(recover).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('其它错误不恢复, 也不重试', async () => {
    const call = vi.fn().mockRejectedValue(Object.assign(new Error('页面超时'), { code: 'timeout' }))
    const recover = vi.fn(async () => {})
    const resource = makeResource({
      bridge: bridgeOf(call),
      assertGranted: () => {},
      recover,
      onClose: () => {},
    })

    // 重试一个"页面超时"只会让模型以为操作被重复执行.
    await expect(resource.value.call('tabs.list', {}, new AbortController().signal)).rejects.toThrow('页面超时')
    expect(recover).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('没有恢复入口时不重试', async () => {
    const call = vi.fn().mockRejectedValue(noBinding())
    const resource = makeResource({
      bridge: bridgeOf(call),
      assertGranted: () => {},
      onClose: () => {},
    })

    await expect(resource.value.call('tabs.list', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'no-binding' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('恢复之后仍然失败, 只重试一次就把错误抛出去', async () => {
    const call = vi.fn().mockRejectedValue(noBinding())
    const recover = vi.fn(async () => {})
    const resource = makeResource({
      bridge: bridgeOf(call),
      assertGranted: () => {},
      recover,
      onClose: () => {},
    })

    await expect(resource.value.call('tabs.list', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'no-binding' })
    expect(recover).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(2)
  })
})
