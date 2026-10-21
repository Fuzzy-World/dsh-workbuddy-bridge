/**
 * 设备令牌（`X-Device-Token`）提供器：phase 2 渠道身份里唯一需要"现算"的输入。
 *
 * 背景：上游 `/v2/chat/completions` 对非官方渠道回 400/11128（unapproved
 * channel）。官方桌面客户端在请求上带 `X-Device-Token: v3:…`；这个值不需要
 * App 配合 —— 它由 App 自带的 N-API addon（`turing-sdk`）在**本进程内存里**
 * 算出（recon 实测约 110 ms、长度 1054–1066、每次调用都不同）。
 *
 * 为什么用原生 addon，而不是抓包 / 读盘 / 连 App 的 IPC：
 * - **App 自产**：addon 就是官方实现本身，算法与随机量与官方客户端同源；
 * - **无网络**：计算发生在本地，recon 未观察到对外请求；
 * - **无落盘**：token 只活在进程内存（recon 对 8 个落点根做前后 mtime 快照，
 *   0 写入；全盘也没有 `v3:` 字面量）。本模块同样不落盘，并且见
 *   {@link createDeviceTokenProvider} 里"显式 `false`"那条注释 —— 连 SDK 的
 *   钥匙串存储面也一并关掉，让"token 只在内存"成为本模块的主动约束。
 *
 * 降级策略：本模块只回答"现在有没有一个能用的 token"。load 失败、`isSupported`
 * 为 false、`configure` 抛错、`fetchDeviceToken` 抛错/超时/返回垃圾，全部收敛成
 * `undefined`。调用方拿到 `undefined` 就**省略这个头**，绝不因此挡下发消息 ——
 * `get()` 永不 throw、永不 reject，它只是可选增强，不是请求的前提。
 *
 * 红线：token 是凭据。它只以返回值形式存在：不写日志、不落盘、不进错误消息、
 * 不进状态文档。日志最多允许 `len=` 与 `prefix=`（前 6 字符）；错误文案在写日志前
 * 统一过一遍 `v3:` 形态的脱敏，防止 addon 的错误消息把 token 带出来。
 *
 * 依赖注入：本模块**不**做安装目录发现，也**不** import 任何 `src/` 模块，只依赖
 * `node:` 内置。路径与 channelId 由装配层查好后传进来（`workbuddy-install.ts` 的
 * `turingSdkModulePath` / `readTuringChannelId`）。这样既避开
 * `client.ts → … → at-rest.ts → client.ts` 那类循环依赖，也让测试完全不碰真实
 * 安装目录和真实 addon。
 *
 * 进程内一次性：addon 的 `configure(channelId, …)` 定死后不可改（recon：换
 * channelId 再 configure 直接抛错）。因此**一个进程只应构造一个提供器**。本模块
 * 刻意不做进程级单例注册表 —— 那会让测试注入的 `load` 互相污染 —— 而是在同一
 * 实例内保证 configure 最多被成功调用一次，失败即进终态。
 *
 * @module dsh-workbuddy-bridge/protocol/device-token
 */

import { createRequire } from 'node:module'

/**
 * 传给 `fetchDeviceToken` 的请求参数。
 *
 * 语义按 addon 的字段名直译，**没有**逐项做单变量差分；recon 只记录了"这组值能
 * 稳定产出 token"。要改这里的任何一项，先按单变量差分跑一遍真机矩阵，别凭字段名
 * 猜（同 `prepareChatBody` 那类"看起来该这样"的改动最容易静默改坏渠道校验）。
 */
export interface NativeFetchDeviceTokenOptions {
  /** 复用 addon 进程内缓存的挑战消息。 */
  usingCachedMessage?: boolean
  /** 允许把已过期的挑战消息也编进 token。 */
  includesOutdatedMessage?: boolean
  /** 把设备信息编进 token。 */
  includesDeviceInfo?: boolean
  /** addon 自己的请求超时。 */
  timeoutMs?: number
}

/**
 * turing-sdk `index.cjs` 的最小结构面。
 *
 * addon 是无类型的 CJS（N-API），拿不到 `.d.ts`；这里只声明本模块用得到的四个
 * 入口，且返回类型一律 `unknown` —— 真实返回（`Promise<string>` 等）由本模块在
 * 运行时校验，不给类型系统一个它会信以为真的承诺。
 */
export interface NativeTuringSdk {
  isSupported(): unknown
  getLoadError(): unknown
  configure(
    channelId: number,
    productName: string,
    productVersion: string,
    keychainStorageEnabled?: boolean,
  ): unknown
  fetchDeviceToken(options?: NativeFetchDeviceTokenOptions): Promise<unknown>
}

/** 提供器的构造参数；全部显式注入，没有环境探测。 */
export interface DeviceTokenOptions {
  /** turing-sdk `index.cjs` 的绝对路径。 */
  modulePath: string
  /** Turing 渠道 id；domestic 版实测 109144（从 App 的 product-config 缓存读，别在调用方硬编码）。 */
  channelId: number
  /** configure() 的产品名；官方客户端用 `WorkBuddy`。 */
  productName: string
  /** configure() 的产品版本；官方客户端用 App 的版本（本机实测 5.8.3）。 */
  productVersion: string
  /** 新鲜度窗口；默认 5 分钟，对齐 App 自己的后台刷新节奏（recon：`DEFAULT_REFRESH_INTERVAL_MS=3e5`）。 */
  ttlMs?: number
  /** 单次取 token 的超时；默认 10s。实测约 110ms，10s 是"卡死"的上限而不是期望值。 */
  timeoutMs?: number
  /** 可注入时钟，测试用；默认 `Date.now`。 */
  now?: () => number
  /** 可注入加载器，测试用；默认按绝对路径 `require`。返回 undefined 表示 addon 不存在或不可加载。 */
  load?: (modulePath: string) => NativeTuringSdk | undefined
  /** 可注入日志器；默认丢弃。**永远不要**把 token 或完整 `configure` 参数之外的凭据传给它。 */
  warn?: (message: string) => void
}

/** 设备令牌提供器。 */
export interface DeviceTokenProvider {
  /** 当前 token；不可用时为 `undefined`。**永不 throw、永不 reject**。 */
  get(signal?: AbortSignal): Promise<string | undefined>
  /** 丢弃缓存（测试用；鉴权失败后也让下一次 get 重新取）。 */
  invalidate(): void
}

/** 默认 TTL：5 分钟，与官方客户端的刷新节奏一致。 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** 默认单次超时：10s。 */
const DEFAULT_TIMEOUT_MS = 10_000

/** token 长度下界；实测 1054–1066，取 64 兼容版本/变体漂移，同时挡住空串与碎片。 */
const TOKEN_MIN_LENGTH = 64

/** token 长度上界；防呆（一个 token 不该有 4KB 以上）。 */
const TOKEN_MAX_LENGTH = 4096

/**
 * 取 token 的请求参数（recon 记录的可产出组合）。
 *
 * `usingCachedMessage` / `includesOutdatedMessage` 都取 `true`，是"照抄实测可用组合"，
 * 不是对字段语义的断言；TTL 由本模块自己管（见 {@link createDeviceTokenProvider}）。
 */
const FETCH_OPTIONS: NativeFetchDeviceTokenOptions = {
  usingCachedMessage: true,
  includesOutdatedMessage: true,
  includesDeviceInfo: true,
}

/**
 * 一个值是否可能是一个合法的设备令牌（也就是是否可以进 HTTP 头）。
 *
 * 三条判据缺一不可：
 * 1. 是字符串 —— addon 理论上返回 `Promise<string>`，但运行时不可信；
 * 2. 长度在 {@link TOKEN_MIN_LENGTH}..{@link TOKEN_MAX_LENGTH} 内；
 * 3. 字符集限定在 ASCII 可打印域且不含空格（`\x21`–`\x7E`）。
 *
 * 为什么不用 `^\S+$` 了事：`\S` 只排除空白，会放行中文、全角符号和所有非 ASCII
 * 字节；而这个值要直接进 header，ASCII 可打印域（base64 + `#` + `:` 的超集）已经
 * 足够宽，却天然挡掉 CR/LF/空格/控制字符/非 ASCII —— 这些正是能拆分请求或伪造
 * 第二个头的东西。公开导出是给 phase 2 的头构建层复用同一个判据。
 */
export function validDeviceToken(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length < TOKEN_MIN_LENGTH || value.length > TOKEN_MAX_LENGTH) return false
  return /^[\x21-\x7E]+$/u.test(value)
}

/**
 * 默认加载器：用 `createRequire` 以真 CJS 语义 require 绝对路径。
 *
 * 刻意不走动态 `import()`：addon 是 `.cjs`，而且 require 的缓存保证同进程内拿到
 * 同一个实例 —— `configure` 进程内一次性，实例必须是同一个（否则第二个实例的
 * channelId 会撞上"不可改"的错）。`.node` 与同目录 DLL 由 SDK 按模块自身路径
 * 解析，与 cwd / PATH 无关（recon 从 `%TEMP%` 作 cwd 实测过）。
 */
function loadNativeModule(modulePath: string): NativeTuringSdk | undefined {
  try {
    return createRequire(import.meta.url)(modulePath) as NativeTuringSdk
  } catch {
    return undefined
  }
}

/**
 * 读 addon 自报的加载失败原因（只用于诊断日志，绝不进返回值）。
 *
 * `getLoadError()` 在成功时可能返回 `null`/`undefined`/空串，统一归一成一句人话。
 */
function loadErrorText(module: NativeTuringSdk): string {
  try {
    const text = module.getLoadError()
    if (typeof text === 'string' && text !== '') return text
    return 'no load error reported'
  } catch {
    return 'getLoadError() threw'
  }
}

/** 错误对象 → 一行文本；不用 `String(error)`，那会把 `[object Object]` 写进日志。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  if (typeof error === 'string' && error !== '') return error
  return 'unknown error'
}

/**
 * 日志脱敏：把 `v3:` 开头的长 token 片段替换成 `v3:<redacted>`，再截断。
 *
 * 这是纵深防御。正常路径里 token 只出现在"返回值"和"对被拒值的 len/prefix 统计"
 * 两处，错误消息本不该含 token；但 addon 是黑盒，它的异常文案不由我们控制，所以
 * 任何要进日志的文本都先过这一层。先脱敏再截断，避免截断把 token 切出一段没有
 * `v3:` 前缀的残片。
 */
function redact(text: string): string {
  return text.replace(/v3:[!-~]{32,}/gu, 'v3:<redacted>').slice(0, 200)
}

/** 被拒返回值的形状描述：只有类型/长度/前 6 字符，永远不含完整 token。 */
function describeReturnedValue(value: unknown): string {
  if (typeof value !== 'string') return `type=${typeof value}`
  return `len=${value.length} prefix=${JSON.stringify(value.slice(0, 6))}`
}

/**
 * 用 `Promise.race` + 定时器兜住 addon 的异步调用。
 *
 * 定时器必须 `unref()`：token 只是可选增强，不能让一个挂住的 addon 把宿主进程
 * 钉在事件循环上。`work` 的两个分支都挂了 handler，所以超时后 `work` 再 reject
 * 也不会变成 unhandled rejection。
 */
function withTimeout<T>(work: Promise<T>, limitMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${limitMs}ms`))
    }, limitMs)
    timer.unref()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        // 非 Error 的 rejection 先脱敏再包成 Error：这条消息只用于日志，但"token
        // 不进错误消息"是红线，内层也不留例外。
        reject(error instanceof Error ? error : new Error(redact(describeError(error))))
      },
    )
  })
}

/**
 * 让一个 Promise 可被 `AbortSignal` 取消：取消时立刻 resolve `undefined`。
 *
 * 取消**不**取消底层 addon 调用（N-API 没有取消面，而且并发调用共用同一个
 * in-flight，取消它会把别的调用方一起拖下水）。只是调用方不再等结果。
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.resolve(undefined)
  const bound = signal
  return new Promise<T | undefined>((resolve) => {
    function onAbort(): void {
      bound.removeEventListener('abort', onAbort)
      resolve(undefined)
    }
    bound.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        bound.removeEventListener('abort', onAbort)
        resolve(value)
      },
      () => {
        bound.removeEventListener('abort', onAbort)
        resolve(undefined)
      },
    )
  })
}

/**
 * 构造一个设备令牌提供器。
 *
 * 状态机（都收敛到 `undefined`，没有"半失败"）：
 * - load / `isSupported` / `configure` 失败 → **终态不可用**，之后不再尝试；
 *   configure 一次性是硬约束，重试只会在同一个错值上再抛一次。
 * - `fetchDeviceToken` 失败/超时/返回垃圾 → **不**进终态（recon：App 自己也是
 *   失败后重试）；缓存仍为空，下一次 `get()` 会重新取。
 * - 成功 → 缓存 `ttlMs`，并发调用共用同一个 in-flight Promise。
 */
export function createDeviceTokenProvider(options: DeviceTokenOptions): DeviceTokenProvider {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const load = options.load ?? loadNativeModule
  const logger = options.warn

  /** addon 实例；只在 configure 成功后赋值（成功的 configure 也只会发生一次）。 */
  let sdk: NativeTuringSdk | undefined
  /** load / isSupported / configure 的终态失败标记：不再重试。 */
  let unavailable = false
  /** 当前缓存的 token 与其过期时刻。 */
  let cached: string | undefined
  let expiresAt = 0
  /** 正在进行的取 token 操作；并发 `get()` 共用它。 */
  let inflight: Promise<string | undefined> | undefined

  /** 日志器是注入的，它自己抛错不能改变提供器的结果。 */
  function note(message: string): void {
    if (logger === undefined) return
    try {
      logger(message)
    } catch {
      // 诊断失败不影响契约：get() 仍然只回答"有没有 token"。
    }
  }

  /**
   * 加载 + 能力探测 + configure，三者合成一次性的初始化。
   *
   * 顺序是刻意的：先 `isSupported()` 再 `configure` —— 不支持的 addon 不该被
   * configure 碰到；`getLoadError()` 只在失败时读，用于把"为什么不可用"留在
   * 日志里（它在成功时是 null）。
   */
  function ensureSdk(): NativeTuringSdk | undefined {
    if (sdk !== undefined) return sdk
    if (unavailable) return undefined

    let loaded: NativeTuringSdk | undefined
    try {
      loaded = load(options.modulePath)
    } catch (error) {
      unavailable = true
      note(`[device-token] load failed: ${redact(describeError(error))}`)
      return undefined
    }
    if (loaded === undefined) {
      unavailable = true
      note(`[device-token] addon not loadable: ${redact(options.modulePath)}`)
      return undefined
    }
    if (
      typeof loaded.isSupported !== 'function' ||
      typeof loaded.getLoadError !== 'function' ||
      typeof loaded.configure !== 'function' ||
      typeof loaded.fetchDeviceToken !== 'function'
    ) {
      unavailable = true
      note('[device-token] addon does not expose the turing-sdk surface')
      return undefined
    }

    let supported: unknown
    try {
      supported = loaded.isSupported()
    } catch (error) {
      unavailable = true
      note(`[device-token] isSupported() threw: ${redact(describeError(error))}`)
      return undefined
    }
    if (supported !== true) {
      unavailable = true
      note(`[device-token] addon unsupported: ${redact(loadErrorText(loaded))}`)
      return undefined
    }

    try {
      // 第 4 参显式 `false`：让 SDK **不**把 token 交给系统钥匙串。省略它等于把
      // "是否落盘"交给 addon 的默认值，而那个默认值只在 win32 上观察过（该平台
      // 压根不用这个参数）；显式 false 才是"token 只在内存"的主动要求。
      loaded.configure(options.channelId, options.productName, options.productVersion, false)
    } catch (error) {
      // configure 进程内一次性（recon：换 channelId 会抛 "channelId cannot
      // change after initialization"）。同一个错值重试没有意义，进终态。
      unavailable = true
      note(`[device-token] configure failed: ${redact(describeError(error))}`)
      return undefined
    }

    sdk = loaded
    return sdk
  }

  /** 真正取一次 token；调用方保证并发去重与超时。失败返回 undefined，不抛。 */
  async function acquire(): Promise<string | undefined> {
    const module = ensureSdk()
    if (module === undefined) return undefined

    const request: NativeFetchDeviceTokenOptions = { ...FETCH_OPTIONS, timeoutMs }
    let raw: unknown
    try {
      // `Promise.resolve().then(...)`：把 addon 的同步 throw 也变成 rejection，
      // 这样下面一个 catch 就能兜住"同步抛 + 异步 reject"两种形状。
      raw = await withTimeout(
        Promise.resolve().then(() => module.fetchDeviceToken(request)),
        timeoutMs,
      )
    } catch (error) {
      note(`[device-token] fetch failed: ${redact(describeError(error))}`)
      return undefined
    }

    if (!validDeviceToken(raw)) {
      note(`[device-token] rejected returned value: ${describeReturnedValue(raw)}`)
      return undefined
    }
    cached = raw
    // 以"拿到 token 的时刻"起算 TTL：token 是刚算出来的，不是请求发起时。
    expiresAt = now() + ttlMs
    return raw
  }

  async function get(signal?: AbortSignal): Promise<string | undefined> {
    try {
      if (signal?.aborted === true) return undefined
      if (cached !== undefined && now() < expiresAt) return cached
      if (unavailable) return undefined
      if (inflight === undefined) {
        const pending = acquire()
        inflight = pending
        // 两条分支都要清：失败也要让下一次 get() 能重试（fetch 失败不进终态）。
        void pending.then(
          () => {
            if (inflight === pending) inflight = undefined
          },
          () => {
            if (inflight === pending) inflight = undefined
          },
        )
      }
      return await abortable(inflight, signal)
    } catch {
      // 契约兜底：get() 永不 reject。任何未预料的错误都按"这次没有 token"处理。
      return undefined
    }
  }

  return {
    get,
    invalidate(): void {
      // 只丢 token，不重置 `unavailable`：addon 不可用是环境事实，不是缓存问题。
      cached = undefined
      expiresAt = 0
    },
  }
}
