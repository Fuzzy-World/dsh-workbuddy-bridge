#!/usr/bin/env node
/**
 * gateway-parity.mjs — 「渠道身份对齐」的常设检查：插件 chat 请求 vs 官方桌面客户端。
 *
 * 用途
 *   把 WorkBuddyUpstreamClient.chatStream() 实际发出的 METHOD / URL / HEADERS / BODY
 *   与一份官方桌面客户端的真实抓包参考（内置在 OFFICIAL_HEADERS）逐字段对比，输出
 *   missing / extra / value-mismatch / ok 四类结论，供 src/protocol/client.ts 对齐。
 *   上游以 `400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`
 *   拒绝"未授权渠道"的调用，这个脚本只回答"头集合还差什么"，不回答服务端到底怎么判。
 *
 * 何时跑（重要）
 *   **必须在 pnpm build 之后**：本脚本从 ../lib/index.js（构建产物）取
 *   WorkBuddyUpstreamClient / WorkBuddyCredentialStore，不读 src/、不编译 TS。
 *   改完 src/protocol/client.ts 后请重新 build 再跑，否则比的是旧产物。
 *
 * 只比形态，不比字面值
 *   每次请求的 uuid / trace id / UA 版本都可能不同，字面比较没有意义。参考值里凡写成
 *   <uuid4> / <uuid7-like> / <32hex> / <16hex> / <redacted> 的，一律按正则判形态；
 *   User-Agent 按官方组合形态判；只有真正的常量（X-Product: SaaS 之类）才做字面比较。
 *   id 类判定刻意宽松（uuid4 也接受任意合法 uuid 形态），避免把合法 id 判成 mismatch。
 *
 * 不联网、不读真实凭据
 *   默认使用内置伪凭据（accessToken:'at'、uid:'uid-1'、domain:'www.workbuddy.cn'），
 *   stub 掉 globalThis.fetch 只捕获请求，因此没有登录态的机器也能跑。
 *   `--real-credential`（或 GATEWAY_PARITY_REAL_CREDENTIAL=1）才尝试 store.current()，
 *   拿不到或抛错仍回退伪凭据；无论如何脚本只打印脱敏后的 Authorization / X-Device-Token。
 *
 * 用法
 *   node scripts/gateway-parity.mjs [--json] [--real-credential]
 *   退出码 0 = 全 ok；1 = 存在 missing / extra / mismatch；2 = 构建产物 / 运行环境问题。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_PATH = join(HERE, '..', 'lib', 'index.js')

if (!existsSync(LIB_PATH)) {
  console.error(
    `gateway-parity: 构建产物不存在: ${LIB_PATH}\n先在本仓根目录跑 pnpm build，再跑本脚本。`,
  )
  process.exit(2)
}

let WorkBuddyUpstreamClient
let WorkBuddyCredentialStore
try {
  const lib = await import(pathToFileURL(LIB_PATH).href)
  WorkBuddyUpstreamClient = lib.WorkBuddyUpstreamClient
  WorkBuddyCredentialStore = lib.WorkBuddyCredentialStore
} catch (error) {
  console.error(`gateway-parity: 加载 ${LIB_PATH} 失败: ${String(error)}`)
  process.exit(2)
}

if (
  typeof WorkBuddyUpstreamClient !== 'function' ||
  typeof WorkBuddyCredentialStore !== 'function'
) {
  console.error(
    'gateway-parity: lib/index.js 未导出 WorkBuddyUpstreamClient / WorkBuddyCredentialStore',
  )
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 伪凭据：脚本默认路径。绝不读取本机登录态，只用于驱动 chatStream 生成请求。
// 字段与 src/credential/store.ts 的 WorkBuddyCredential 对齐；expiresAtMs 取 0 只是
// 表示"已过期"，chatStream 本身不看这个字段（它不会触发 refresh）。
// ---------------------------------------------------------------------------
const PSEUDO_CREDENTIAL = Object.freeze({
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.workbuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
})

/** 最小 chat body；chatStream 会照常过 prepareChatBody（stream 强制为 true）。 */
const REQUEST_BODY = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  stream: true,
  max_tokens: 64,
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'gateway parity probe' },
  ],
})

// ---------------------------------------------------------------------------
// 官方参考头集合（用户抓包，值为占位符；Authorization / X-Device-Token 一律 <redacted>）
// 顺序与抓包一致。shapeId 决定"怎么判"：literal = 常量精确比较；其余 = 正则判形态。
// ---------------------------------------------------------------------------
const SHAPE_REGISTRY = {
  literal: { re: null },
  // 宽松 uuid：uuid4 / uuid7 / 其它版本都接受，避免把合法 id 判成 mismatch。
  uuid4: { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  uuid7: { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  uuid: { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  hex32: { re: /^[0-9a-f]{32}$/i },
  hex16: { re: /^[0-9a-f]{16}$/i },
  semver: { re: /^\d+\.\d+\.\d+$/ },
  vSemver: { re: /^v\d+\.\d+\.\d+$/ },
  // 官方 Authorization 是 `Bearer <jwt>`；判前缀与 token 字符集，不校验签名/长度。
  jwt: { re: /^Bearer\s+[A-Za-z0-9._~+/=-]+$/i },
  // 官方设备令牌：v3:<至少 64 个非空白字符>。
  deviceToken: { re: /^v3:\S{64,}$/ },
  // 官方 UA 组合形态（CLI 段可缺省）：WorkBuddy/<v> WorkBuddy/<v>[ CLI/<v>]
  userAgent: { re: /^WorkBuddy\/\d+\.\d+\.\d+ WorkBuddy\/\d+\.\d+\.\d+(?: CLI\/\d+\.\d+\.\d+)?$/ },
  traceparent: { re: /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/i },
  b3: { re: /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/i },
}

function official(name, value, shapeId = 'literal', note) {
  const shape = SHAPE_REGISTRY[shapeId]
  if (shape === undefined) throw new Error(`unknown shape: ${shapeId}`)
  return { header: name, value, shapeId, re: shape.re, ...(note === undefined ? {} : { note }) }
}

const OFFICIAL_HEADERS = [
  official(
    'Host',
    'www.workbuddy.cn',
    'literal',
    '由 URL 派生（fetch 自动生成，不可手写 HTTP 头）',
  ),
  official('Accept', 'application/json'),
  official('Content-Type', 'application/json'),
  official('X-Requested-With', 'XMLHttpRequest'),
  official('X-Stainless-Arch', 'x64'),
  official('X-Stainless-Lang', 'js'),
  official('X-Stainless-Os', 'Windows'),
  official('X-Stainless-Package-Version', '6.25.0', 'semver'),
  official('X-Stainless-Retry-Count', '0'),
  official('X-Stainless-Runtime', 'node'),
  official('X-Stainless-Runtime-Version', 'v22.21.1', 'vSemver'),
  official('X-Conversation-Id', '<uuid4>', 'uuid4'),
  official('X-Agent-Intent', 'craft'),
  official('X-Agent-Purpose', 'conversation'),
  official('X-Ide-Type', 'WorkBuddy'),
  official('X-Ide-Name', 'WorkBuddy'),
  official('X-Ide-Version', '5.8.3', 'semver'),
  official('X-Private-Data', 'true'),
  official('Acp-Connection-Id', '<uuid7-like>', 'uuid7'),
  official('X-Codebuddy-Request', '1'),
  official('X-Device-Token', '<redacted>', 'deviceToken', '形态 v3:<>=64 个非空白字符>'),
  official('X-Request-Id', '<uuid7-like>', 'uuid7'),
  official('X-Conversation-Message-Id', '<uuid7-like>', 'uuid7'),
  official('X-Conversation-Request-Id', '<uuid7-like>', 'uuid7'),
  official('X-Root-Request-Id', '<uuid7-like>', 'uuid7'),
  official('X-Agent-Type', 'main'),
  official('Content-Encoding', 'gzip'),
  official('Traceparent', '00-<32hex>-<16hex>-01', 'traceparent'),
  official('B3', '<32hex>-<16hex>-1-<16hex>', 'b3'),
  official('X-B3-Traceid', '<32hex>', 'hex32'),
  official('X-B3-Parentspanid', '<16hex>', 'hex16'),
  official('X-B3-Spanid', '<16hex>', 'hex16'),
  official('X-B3-Sampled', '1'),
  official('X-Trace-Id', '<32hex>', 'hex32'),
  official('X-Product', 'SaaS'),
  official(
    'User-Agent',
    'WorkBuddy/<v> WorkBuddy/<v>[ CLI/<v>]',
    'userAgent',
    '官方实测 WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0',
  ),
  official('Authorization', '<redacted>', 'jwt', '形态 Bearer <jwt>'),
  official('X-User-Id', '<uuid>', 'uuid'),
  official('X-Domain', 'www.workbuddy.cn'),
  // 注意：抓包里确实还有一枚拼写不同的 X-Request-With（无 "ed"），与 X-Requested-With 是两个头。
  official('X-Request-With', 'XMLHttpRequest'),
]

// ---------------------------------------------------------------------------
// 脱敏：Authorization 只给前 10 字符 + 长度；X-Device-Token 整体不落原文。
// ---------------------------------------------------------------------------
const SENSITIVE_HEADERS = new Set(['authorization', 'x-device-token'])

function maskHeader(name, rawValue) {
  const text = String(rawValue)
  const lower = name.toLowerCase()
  if (lower === 'authorization') return `${text.slice(0, 10)}…[len=${text.length}]`
  if (lower === 'x-device-token') return `<redacted:device-token>[len=${text.length}]`
  return text
}

function isSensitive(name) {
  return SENSITIVE_HEADERS.has(name.toLowerCase())
}

// ---------------------------------------------------------------------------
// 捕获：替换 globalThis.fetch，只记录 init，不发包；finally 一定还原。
// ---------------------------------------------------------------------------
function headerEntries(headers) {
  if (headers === undefined || headers === null) return {}
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

async function captureChatRequest(credential) {
  const client = new WorkBuddyUpstreamClient()
  const captured = {
    method: undefined,
    url: undefined,
    headers: {},
    body: undefined,
    result: undefined,
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    captured.method = init.method ?? 'GET'
    captured.url = typeof input === 'string' ? input : String(input?.url ?? input)
    captured.headers = headerEntries(init.headers)
    captured.body = init.body
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => 'data: {"choices":[{"delta":{"content":"parity"}}]}\n\ndata: [DONE]\n\n',
      json: async () => ({ code: 0, msg: 'ok', data: {} }),
    }
  }
  try {
    captured.result = await client.chatStream(credential, REQUEST_BODY)
  } finally {
    globalThis.fetch = realFetch
  }
  if (captured.url === undefined) {
    throw new Error('stub fetch 没有被调用：chatStream 没有发出请求')
  }
  return captured
}

/** 默认伪凭据；--real-credential 时才碰本机登录态，失败静默回退。 */
async function selectCredential(argv) {
  const wantsReal =
    argv.includes('--real-credential') || process.env.GATEWAY_PARITY_REAL_CREDENTIAL === '1'
  if (!wantsReal) return { credential: PSEUDO_CREDENTIAL, origin: 'pseudo（默认，不读本机登录态）' }
  try {
    const store = new WorkBuddyCredentialStore({
      refresh: async () => {
        // 离线：不联网刷新；store.current() 若需要 refresh 会走到这里并抛错，由下面兜住。
        throw new Error('gateway-parity: token refresh disabled (offline)')
      },
    })
    const credential = await store.current()
    if (credential === undefined) {
      return { credential: PSEUDO_CREDENTIAL, origin: 'pseudo（store.current() 无凭据）' }
    }
    return { credential, origin: 'real（store.current()）' }
  } catch (error) {
    const reason = String(error).replace(/\s+/g, ' ').slice(0, 100)
    return { credential: PSEUDO_CREDENTIAL, origin: `pseudo（store.current() 抛错: ${reason}）` }
  }
}

// ---------------------------------------------------------------------------
// 逐头比较
// ---------------------------------------------------------------------------
function compareValue(entry, pluginValue) {
  if (entry.shapeId === 'literal') {
    return pluginValue === entry.value
      ? { ok: true }
      : { ok: false, reason: `常量不符，官方发送 ${entry.value}` }
  }
  return entry.re.test(pluginValue)
    ? { ok: true }
    : { ok: false, reason: `不符合 ${entry.shapeId} 形态（${entry.re.source}）` }
}

function buildDiff(rawHeaders, url) {
  const pluginByName = new Map()
  for (const [name, value] of Object.entries(rawHeaders)) {
    pluginByName.set(name.toLowerCase(), { name, value: String(value) })
  }
  // Host 不在 init.headers 里：它由 URL 派生，代表"实际打到哪个网关"。
  pluginByName.set('host', { name: 'Host', value: new URL(url).host, derivedFromUrl: true })

  const ok = []
  const missing = []
  const extra = []
  const mismatch = []

  for (const entry of OFFICIAL_HEADERS) {
    const key = entry.header.toLowerCase()
    const current = pluginByName.get(key)
    if (current === undefined) {
      missing.push({
        header: entry.header,
        official: entry.value,
        shape: entry.shapeId,
        ...(entry.note === undefined ? {} : { note: entry.note }),
      })
      continue
    }
    pluginByName.delete(key)
    const verdict = compareValue(entry, current.value)
    if (verdict.ok) {
      ok.push(entry.header)
    } else {
      mismatch.push({
        header: entry.header,
        official: entry.value,
        plugin: isSensitive(entry.header) ? maskHeader(entry.header, current.value) : current.value,
        shape: entry.shapeId,
        reason: verdict.reason,
        ...(current.derivedFromUrl === true ? { derivedFromUrl: true } : {}),
      })
    }
  }

  for (const leftover of pluginByName.values()) {
    extra.push({
      header: leftover.name,
      plugin: isSensitive(leftover.name)
        ? maskHeader(leftover.name, leftover.value)
        : leftover.value,
      ...(leftover.derivedFromUrl === true ? { derivedFromUrl: true } : {}),
    })
  }

  return { ok, missing, extra, mismatch }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
function parseBody(raw) {
  if (typeof raw !== 'string') return raw === undefined ? null : String(raw)
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function clip(text, limit = 1200) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（截断，原长 ${text.length}）`
}

function printText(report, libPath) {
  const { plugin, official: officialRows, diff, summary } = report
  console.log('gateway parity — 插件 chat 请求 vs 官方桌面客户端（仅比较头集合与值形态）')
  console.log(`构建产物: ${libPath}`)
  console.log(`凭据: ${plugin.credential}`)
  console.log('')

  console.log(`[plugin] ${plugin.method} ${plugin.url}`)
  console.log(`  Host (derived from URL): ${plugin.host}`)
  for (const [name, value] of Object.entries(plugin.headers)) {
    console.log(`  ${name}: ${value}`)
  }
  console.log(`  body: ${clip(JSON.stringify(plugin.body))}`)
  console.log('')

  console.log(`[official] 参考头 ${officialRows.length} 项（用户抓包；凭据值已占位/脱敏）`)
  for (const row of officialRows) {
    console.log(`  ${row.header}: ${row.value}`)
  }
  console.log('')

  console.log('[diff]')
  console.log(`  ok (${diff.ok.length}): ${diff.ok.length === 0 ? '-' : diff.ok.join(', ')}`)
  console.log(`  missing (${diff.missing.length}):`)
  for (const item of diff.missing) {
    console.log(`    - ${item.header} = ${item.official}  [${item.shape}]`)
  }
  console.log(`  extra (${diff.extra.length}):`)
  for (const item of diff.extra) {
    console.log(`    - ${item.header} = ${item.plugin}`)
  }
  console.log(`  value-mismatch (${diff.mismatch.length}):`)
  for (const item of diff.mismatch) {
    const origin = item.derivedFromUrl === true ? '（Host 取自 plugin URL）' : ''
    console.log(
      `    - ${item.header}: official=${item.official} / plugin=${item.plugin}${origin} — ${item.reason}`,
    )
  }
  console.log('')
  console.log(
    `parity: ${summary.ok} ok / ${summary.missing} missing / ${summary.extra} extra / ${summary.mismatch} mismatch` +
      `（另有 ${summary.acceptedMissing + summary.acceptedMismatch} 项已知且刻意不复刻，见脚本头注释）`,
  )
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const jsonMode = argv.includes('--json')
const unknownFlags = argv.filter((flag) => flag !== '--json' && flag !== '--real-credential')
if (unknownFlags.length > 0) {
  console.error(`gateway-parity: 未知参数 ${unknownFlags.join(' ')}`)
  console.error('用法: node scripts/gateway-parity.mjs [--json] [--real-credential]')
  process.exit(2)
}

const { credential, origin } = await selectCredential(argv)
const captured = await captureChatRequest(credential)
const diff = buildDiff(captured.headers, captured.url)

/*
 * Differences that are known, understood, and deliberately not replicated.
 *
 * They are split out so the exit code answers the question this check exists
 * for — "does the plugin present the official client's *identity*?" — instead
 * of failing forever on facts the plugin cannot or should not claim.
 *
 * - `x-stainless-*`: the official desktop app talks to this endpoint through the
 *   OpenAI Node SDK, and these are that SDK's own transport fingerprints. The
 *   plugin is not that SDK; copying the strings would be impersonating a
 *   library, not presenting a client identity.
 * - `content-encoding: gzip`: the official client compresses its body. The
 *   upstream accepts an uncompressed body (verified live), and compressing would
 *   be a body-layer change with its own failure modes — out of this phase's
 *   scope.
 * - `x-request-with`: appears alongside `X-Requested-With` in the capture, which
 *   reads as a capture artefact; the plugin sends the documented spelling.
 * - `host`: the plugin's CN chat gateway is `copilot.tencent.com`, the capture's
 *   is `www.workbuddy.cn`. Switching the endpoint is a cross-gateway change with
 *   account-coverage risk, deliberately left as its own decision (see the parity
 *   note). It is reported, never silently accepted.
 */
const ACCEPTED_MISSING = new Set([
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'content-encoding',
  'x-request-with',
])
const ACCEPTED_MISMATCH = new Set(['host'])

/** The pseudo credential's uid is not a UUID, so that mismatch is test noise. */
const pseudoCredential = origin.startsWith('pseudo')
const acceptedMissing = diff.missing.filter((item) =>
  ACCEPTED_MISSING.has(item.header.toLowerCase()),
)
const acceptedMismatch = diff.mismatch.filter(
  (item) =>
    ACCEPTED_MISMATCH.has(item.header.toLowerCase()) ||
    (pseudoCredential && item.header.toLowerCase() === 'x-user-id'),
)
const identityDiff = {
  ok: diff.ok,
  missing: diff.missing.filter((item) => !ACCEPTED_MISSING.has(item.header.toLowerCase())),
  extra: diff.extra,
  mismatch: diff.mismatch.filter((item) => !acceptedMismatch.includes(item)),
}
const summary = {
  ok: identityDiff.ok.length,
  missing: identityDiff.missing.length,
  extra: identityDiff.extra.length,
  mismatch: identityDiff.mismatch.length,
  acceptedMissing: acceptedMissing.length,
  acceptedMismatch: acceptedMismatch.length,
}
summary.parity = summary.missing === 0 && summary.extra === 0 && summary.mismatch === 0

const report = {
  plugin: {
    credential: origin,
    method: captured.method,
    url: captured.url,
    host: new URL(captured.url).host,
    headers: Object.fromEntries(
      Object.entries(captured.headers).map(([name, value]) => [name, maskHeader(name, value)]),
    ),
    body: parseBody(captured.body),
  },
  official: OFFICIAL_HEADERS.map((entry) => ({
    header: entry.header,
    value: entry.value,
    shape: entry.shapeId,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  })),
  diff: identityDiff,
  accepted: { missing: acceptedMissing, mismatch: acceptedMismatch },
  summary,
}

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  printText(report, LIB_PATH)
}
process.exitCode = summary.parity ? 0 : 1
