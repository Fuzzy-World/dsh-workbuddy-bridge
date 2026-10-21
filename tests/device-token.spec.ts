import { describe, expect, it, vi } from 'vitest'
import {
  createDeviceTokenProvider,
  validDeviceToken,
  type NativeFetchDeviceTokenOptions,
  type NativeTuringSdk,
} from '../src/protocol/device-token.ts'

/**
 * 设备令牌提供器的离线用例。
 *
 * 纪律：**不** require 真实 addon，**不**碰真实文件系统 —— 每个用例都通过 `load`
 * 注入假 SDK，路径只是一个字符串。要验证的是提供器的契约：configure 一次性、
 * TTL 复用、并发去重、所有失败面收敛成 `undefined`、以及 token 永不进日志。
 */

const CHANNEL_ID = 109144
const PRODUCT_NAME = 'WorkBuddy'
const PRODUCT_VERSION = '5.8.3'

/**
 * 一个形状像真实产出的 token：`v3:` + 可打印 ASCII，长于提供器的 64 字符下界。
 * 值本身是假的；用例只关心形状与"不泄露"。
 */
const TOKEN = `v3:abc${'k'.repeat(96)}`

/** 一个假的 turing-sdk addon；每个入口都是 spy，既能断言结果也能断言调用模式。 */
function makeSdk(
  overrides: {
    supported?: boolean
    loadError?: unknown
    configure?: () => unknown
    fetch?: () => Promise<unknown>
  } = {},
) {
  const isSupported = vi.fn((): unknown => overrides.supported ?? true)
  const getLoadError = vi.fn((): unknown => overrides.loadError ?? null)
  const configure = vi.fn((..._args: unknown[]): unknown => overrides.configure?.() ?? undefined)
  const fetchDeviceToken = vi.fn(
    (_options?: NativeFetchDeviceTokenOptions): Promise<unknown> =>
      overrides.fetch?.() ?? Promise.resolve(TOKEN),
  )
  const sdk: NativeTuringSdk = { isSupported, getLoadError, configure, fetchDeviceToken }
  return { sdk, isSupported, getLoadError, configure, fetchDeviceToken }
}

/**
 * 构造一个只依赖注入的提供器。
 *
 * `sdk` 与 `load` 二选一：给了 `load` 就完全接管加载（用例 4），否则返回注入的
 * 假 SDK。可选字段用条件展开，符合仓库的 `exactOptionalPropertyTypes` 写法。
 */
function setup(
  options: {
    sdk?: ReturnType<typeof makeSdk> | undefined
    load?: (modulePath: string) => NativeTuringSdk | undefined
    now?: () => number
    ttlMs?: number
    timeoutMs?: number
  } = {},
) {
  const warn = vi.fn((_message: string): void => {})
  const load = vi.fn((modulePath: string): NativeTuringSdk | undefined => {
    if (options.load !== undefined) return options.load(modulePath)
    return options.sdk?.sdk
  })
  const provider = createDeviceTokenProvider({
    modulePath: '/virtual/resources/app.asar.unpacked/native/turing-sdk/index.cjs',
    channelId: CHANNEL_ID,
    productName: PRODUCT_NAME,
    productVersion: PRODUCT_VERSION,
    load,
    warn,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return { provider, load, warn }
}

/** 把所有 warn 调用拼成一行，便于做"不得含 token"的断言。 */
function loggedText(warn: ReturnType<typeof vi.fn<(message: string) => void>>): string {
  return warn.mock.calls.map(([message]) => message).join('\n')
}

describe('createDeviceTokenProvider', () => {
  it('configures the addon once and returns the produced token', async () => {
    const sdk = makeSdk()
    const { provider, warn } = setup({ sdk })

    await expect(provider.get()).resolves.toBe(TOKEN)

    // configure 收到的就是官方客户端的三个参数；第 4 参显式 false（不落钥匙串）。
    expect(sdk.configure).toHaveBeenCalledTimes(1)
    expect(sdk.configure).toHaveBeenCalledWith(CHANNEL_ID, PRODUCT_NAME, PRODUCT_VERSION, false)
    expect(sdk.isSupported).toHaveBeenCalledTimes(1)
    expect(sdk.fetchDeviceToken).toHaveBeenCalledTimes(1)
    // 超时也要传给 addon 自己，外层兜底与内层超时是同一个预算。
    expect(sdk.fetchDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 10_000 }),
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('reuses the token inside the freshness window and refreshes after it', async () => {
    let clock = 1_000
    const sdk = makeSdk()
    const { provider } = setup({ sdk, now: () => clock })

    await expect(provider.get()).resolves.toBe(TOKEN)
    clock += 4 * 60_000
    await expect(provider.get()).resolves.toBe(TOKEN)
    expect(sdk.fetchDeviceToken).toHaveBeenCalledTimes(1)

    // 越过默认 5 分钟 TTL：必须重新取，而不是拿一份过期 token 去撞 11128。
    clock += 61_000
    await expect(provider.get()).resolves.toBe(TOKEN)
    expect(sdk.fetchDeviceToken).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent callers into one addon call', async () => {
    // 故意异步 resolve：证明 5 个调用方真的共用同一个 in-flight，而不是各自算完
    // 恰好都成功。
    const sdk = makeSdk({
      fetch: () => new Promise<unknown>((resolve) => setTimeout(() => resolve(TOKEN), 1)),
    })
    const { provider } = setup({ sdk })

    const results = await Promise.all(Array.from({ length: 5 }, () => provider.get()))

    expect(sdk.fetchDeviceToken).toHaveBeenCalledTimes(1)
    expect(results).toEqual(Array.from({ length: 5 }, () => TOKEN))
  })

  it('returns undefined when the addon cannot be loaded, and stops retrying', async () => {
    const { provider, load } = setup({ load: () => undefined })

    await expect(provider.get()).resolves.toBeUndefined()
    await expect(provider.get()).resolves.toBeUndefined()

    // 不可加载是终态：不反复碰文件系统，也不反复 require。
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('returns undefined when the addon reports itself unsupported', async () => {
    const loadError = 'TuringShieldSDK.dll could not be loaded'
    const sdk = makeSdk({ supported: false, loadError })
    const { provider, warn } = setup({ sdk })

    const token = await provider.get()

    expect(token).toBeUndefined()
    // 加载失败原因只允许留在诊断日志里，绝不能混进返回值（返回值只有 token 或 undefined）。
    expect(String(token)).not.toContain(loadError)
    expect(sdk.configure).not.toHaveBeenCalled()
    expect(loggedText(warn)).toContain(loadError)
  })

  it('does not reconfigure after configure fails', async () => {
    const sdk = makeSdk({
      configure: () => {
        throw new Error('Turing SDK channelId cannot change after initialization')
      },
    })
    const { provider, load } = setup({ sdk })

    await expect(provider.get()).resolves.toBeUndefined()
    await expect(provider.get()).resolves.toBeUndefined()

    // configure 是进程内一次性的：同一个错值再试一次只会在同一个错上再抛一次。
    expect(sdk.configure).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(sdk.fetchDeviceToken).not.toHaveBeenCalled()
  })

  it('retries a failed fetch instead of poisoning the provider', async () => {
    let attempts = 0
    const sdk = makeSdk()
    sdk.fetchDeviceToken.mockImplementation(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient N-API failure')
      return TOKEN
    })
    const { provider } = setup({ sdk })

    await expect(provider.get()).resolves.toBeUndefined()
    await expect(provider.get()).resolves.toBe(TOKEN)

    // fetch 失败不是终态：addon 本身可用，下一次 get 重新取即可。
    expect(sdk.fetchDeviceToken).toHaveBeenCalledTimes(2)
    expect(sdk.configure).toHaveBeenCalledTimes(1)
  })

  it('rejects returned values that cannot be a header value', async () => {
    const cases: readonly unknown[] = [
      '', // 空串
      '   ', // 只有空格：header 值里不允许
      `${TOKEN}\n`, // 换行：能拆分请求
      `${TOKEN}\r\nX-Injected: 1`, // CRLF 注入形状
      42, // 非字符串
      null,
    ]
    for (const value of cases) {
      const sdk = makeSdk({ fetch: async () => value })
      const { provider } = setup({ sdk })
      await expect(provider.get()).resolves.toBeUndefined()
      // 垃圾值不缓存；提供器仍然可用，下次还能重新取。
      expect(sdk.fetchDeviceToken).toHaveBeenCalledTimes(1)
    }
  })

  it('times out an addon call that never settles', async () => {
    const sdk = makeSdk({ fetch: () => new Promise<unknown>(() => {}) })
    const { provider } = setup({ sdk, timeoutMs: 20 })

    const started = Date.now()
    await expect(provider.get()).resolves.toBeUndefined()
    const elapsed = Date.now() - started

    // 定时器（且 unref）必须真的把等待截断；20ms 的预算不许变成 5s。
    expect(elapsed).toBeGreaterThanOrEqual(15)
    expect(elapsed).toBeLessThan(5_000)
    expect(sdk.fetchDeviceToken).toHaveBeenCalledTimes(1)
  })

  it('never puts the token into logs, even when the addon errors with it', async () => {
    // 最坏情况：addon 的异常文案里带着它刚算出来的 token。
    const sdk = makeSdk({
      fetch: async () => {
        throw new Error(`handshake failed: ${TOKEN}`)
      },
    })
    const { provider, warn } = setup({ sdk })

    await expect(provider.get()).resolves.toBeUndefined()

    const logged = loggedText(warn)
    expect(logged).not.toBe('')
    expect(logged).not.toContain(TOKEN)
    // 脱敏后仍能看出"这里原本是一段 token 形态的内容"，保持诊断价值。
    expect(logged).toContain('v3:<redacted>')

    // 另一条失败路径：addon 返回了带换行的 token（被 header-safe 校验拒绝）。
    const invalid = makeSdk({ fetch: async () => `${TOKEN}\n` })
    const rejected = setup({ sdk: invalid })
    await expect(rejected.provider.get()).resolves.toBeUndefined()
    const rejectionLog = loggedText(rejected.warn)
    expect(rejectionLog).toContain('len=')
    expect(rejectionLog).toContain('prefix=')
    expect(rejectionLog).not.toContain(TOKEN)
  })

  it('invalidates the cached token on demand', async () => {
    const sdk = makeSdk()
    const { provider } = setup({ sdk })

    await expect(provider.get()).resolves.toBe(TOKEN)
    provider.invalidate()
    await expect(provider.get()).resolves.toBe(TOKEN)

    expect(sdk.fetchDeviceToken).toHaveBeenCalledTimes(2)
  })

  it('answers an already-aborted caller without touching the addon', async () => {
    const sdk = makeSdk()
    const { provider } = setup({ sdk })
    const controller = new AbortController()
    controller.abort()

    await expect(provider.get(controller.signal)).resolves.toBeUndefined()
    expect(sdk.fetchDeviceToken).not.toHaveBeenCalled()
  })
})

describe('validDeviceToken', () => {
  it('accepts printable-ASCII tokens of a plausible length', () => {
    expect(validDeviceToken(TOKEN)).toBe(true)
    // 长度边界：64 是下界，4096 是上界，两端都含。
    expect(validDeviceToken(`v3:${'a'.repeat(61)}`)).toBe(true)
    expect(validDeviceToken(`v3:${'a'.repeat(4093)}`)).toBe(true)
  })

  it('rejects everything that could not safely reach a header', () => {
    expect(validDeviceToken(`v3:${'a'.repeat(60)}`)).toBe(false) // 63：太短
    expect(validDeviceToken(`v3:${'a'.repeat(4094)}`)).toBe(false) // 4097：太长
    expect(validDeviceToken(`${TOKEN}\n`)).toBe(false)
    expect(validDeviceToken(`${TOKEN} `)).toBe(false)
    expect(validDeviceToken(`${TOKEN.slice(0, 32)} ${TOKEN.slice(32)}`)).toBe(false)
    expect(validDeviceToken('v3:令牌'.repeat(20))).toBe(false) // 非 ASCII
    expect(validDeviceToken(42)).toBe(false)
    expect(validDeviceToken(undefined)).toBe(false)
  })
})
