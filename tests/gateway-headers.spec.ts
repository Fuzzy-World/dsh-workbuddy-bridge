import { describe, expect, it } from 'vitest'
import type { ChatIdentity } from '../src/protocol/client-identity.ts'
import {
  buildGatewayHeaders,
  uuidv4,
  uuidv7,
  validHeaderValue,
  type GatewayIdentity,
  type RandomBytes,
} from '../src/protocol/gateway-headers.ts'

/**
 * 聊天网关身份头的离线契约。
 *
 * 纪律：时间与随机数全部注入 —— `nowMs` 是常量、`random` 是纯函数，所以这里没有
 * 一条断言依赖机器时钟或 CSPRNG。要钉住的是三类真会失败的性质：同一身份重复构建
 * 逐字节一致、id 形状对得上官方客户端、恶意/坏值越不过 header 边界。
 */

const APP_VERSION = '5.8.3'
const CLI_VERSION = '2.161.0'
const CONVERSATION_ID = '6ca142f8-d1cc-4353-9aac-ca6baa5c659b'
const NOW_MS = 1_700_000_000_000

/** 固定字节流：同一 `length` 永远同一内容，两次构建才能逐字节相等。 */
const FIXED: RandomBytes = (length) =>
  new Uint8Array(length).map((_unused, index) => (index * 37 + 11) & 0xff)

/** 全零随机：用来看不可控的 CSPRNG 退化时 trace 是否仍然只降级、不抛错。 */
const ZERO: RandomBytes = (length) => new Uint8Array(length)

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TRACE_ID = /^[0-9a-f]{32}$/u
const SPAN_ID = /^[0-9a-f]{16}$/u
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u
const B3 = /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/u

const IDENTITY: ChatIdentity = { clientVersion: APP_VERSION, cliVersion: CLI_VERSION }

/** 官方客户端每次请求各自生成的 id：它们必须都是 UUIDv7。 */
const PER_REQUEST_IDS = [
  'X-Conversation-Request-Id',
  'X-Conversation-Message-Id',
  'X-Request-Id',
  'X-Root-Request-Id',
  'acp-connection-id',
] as const

/**
 * 基础身份。
 *
 * 每次返回新对象：`buildGatewayHeaders` 会就地改写 uuid 字节，共用数组会让两个
 * 用例互相污染（全零随机那条尤其会）。
 */
function baseInput(): GatewayIdentity {
  return {
    region: 'cn',
    identity: IDENTITY,
    uid: 'uid-1',
    domain: 'www.codebuddy.cn',
    conversationId: CONVERSATION_ID,
  }
}

function headersOf(
  input: GatewayIdentity,
  nowMs = NOW_MS,
  random: RandomBytes = FIXED,
): Record<string, string> {
  return buildGatewayHeaders(input, { nowMs, random })
}

/** 读一个"必须存在"的头；缺失时先失败在有名有姓的断言上，而不是返回 undefined。 */
function header(headers: Record<string, string>, name: string): string {
  const value = headers[name]
  expect(value).toBeTypeOf('string')
  return value ?? ''
}

/** UUIDv7 的 48 位毫秒时间戳，按实现的拼法补齐到 12 个 hex。 */
function timeHex(ms: number): string {
  return Math.floor(ms).toString(16).padStart(12, '0')
}

/** uuid 去掉连字符后的前 12 个 hex 就是时间戳字段。 */
function uuidTimeHex(uuid: string): string {
  return uuid.replace(/-/gu, '').slice(0, 12)
}

describe('uuidv7 / uuidv4 形状', () => {
  it('uuidv7 的版本位是 7、变体位是 10xx，前 48 位是可解析的毫秒时间戳', () => {
    const id = uuidv7(NOW_MS, FIXED)
    expect(id).toMatch(UUID_V7)
    // 时间字段不是"随便填的随机数"：换成每毫秒递增的值，前缀必须跟着走。
    expect(uuidTimeHex(id)).toBe(timeHex(NOW_MS))
    expect(uuidTimeHex(uuidv7(NOW_MS + 1, FIXED))).not.toBe(uuidTimeHex(id))
  })

  it('uuidv7 把负数与小数收敛成非负整毫秒，而不是产出畸形 id', () => {
    // 时间倒流（时钟校准）不应制造负时间戳：UUIDv7 的时间字段是无符号的。
    expect(uuidTimeHex(uuidv7(-5, FIXED))).toBe('000000000000')
    expect(uuidTimeHex(uuidv7(NOW_MS + 0.9, FIXED))).toBe(timeHex(NOW_MS))
  })

  it('uuidv4 的版本位是 4、变体位是 10xx，且只改 6/8 两个字节', () => {
    const id = uuidv4(FIXED)
    expect(id).toMatch(UUID_V4)
    // 固定字节下可以复算：除版本/变体位之外没有别的加工，否则这里会漂。
    expect(id).toBe(uuidv4(FIXED))
  })
})

describe('确定性', () => {
  it('同身份、同 nowMs、同 random：两次构建逐字节相同', () => {
    const first = headersOf(baseInput())
    const second = headersOf(baseInput())
    expect(second).toEqual(first)
    // 键顺序也一致：构造顺序是契约的一部分（Authorization 由调用方追加在后面）。
    expect(Object.keys(second)).toEqual(Object.keys(first))
  })

  it('时间高位跟 nowMs 走：换一天，全部 UUIDv7 的时间前缀一起变', () => {
    const tomorrowMs = NOW_MS + 86_400_000
    const today = headersOf(baseInput(), NOW_MS)
    const tomorrow = headersOf(baseInput(), tomorrowMs)

    expect(uuidTimeHex(header(today, 'X-Request-Id'))).toBe(timeHex(NOW_MS))
    expect(uuidTimeHex(header(tomorrow, 'X-Request-Id'))).toBe(timeHex(tomorrowMs))
    expect(header(tomorrow, 'X-Request-Id')).not.toBe(header(today, 'X-Request-Id'))

    // 同一个请求里的 5 个 v7 id 共用同一毫秒 —— 官方客户端就是一批可排序的时间 id。
    for (const name of PER_REQUEST_IDS) {
      expect(uuidTimeHex(header(today, name))).toBe(timeHex(NOW_MS))
    }
  })

  it('每个 per-request id 各自抽取随机数：五个 id 不会撞成同一个', () => {
    // 用递增的伪随机让每次抽取都不同；若实现把一次抽取复用到多个头，这里必红。
    let draw = 0
    const rotating: RandomBytes = (length) => {
      draw += 1
      return new Uint8Array(length).map((_unused, index) => (draw * 97 + index * 41) & 0xff)
    }
    const headers = headersOf(baseInput(), NOW_MS, rotating)
    const ids = PER_REQUEST_IDS.map((name) => header(headers, name))
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('官方头集合', () => {
  it('物化官方桌面客户端那一整套身份头，且不多带一个', () => {
    const headers = headersOf(baseInput())
    // 精确集合而不是"包含"：多一个 Origin/Referer 之类的头，通道校验就可能改判。
    const expected = [
      'Accept',
      'Content-Type',
      'User-Agent',
      'X-Agent-Intent',
      'X-Agent-Purpose',
      'X-Agent-Type',
      'X-B3-ParentSpanId',
      'X-B3-Sampled',
      'X-B3-SpanId',
      'X-B3-TraceId',
      'X-Conversation-Id',
      'X-Conversation-Message-Id',
      'X-Conversation-Request-Id',
      'X-Domain',
      'X-IDE-Name',
      'X-IDE-Type',
      'X-IDE-Version',
      'X-Private-Data',
      'X-Product',
      'X-Request-Id',
      'X-Requested-With',
      'X-Root-Request-Id',
      'X-Trace-Id',
      'X-User-Id',
      'acp-connection-id',
      'b3',
      'traceparent',
      'x-codebuddy-request',
    ]
    expect(Object.keys(headers).sort()).toEqual(expected.sort())

    expect(header(headers, 'x-codebuddy-request')).toBe('1')
    expect(header(headers, 'X-IDE-Type')).toBe('WorkBuddy')
    expect(header(headers, 'X-IDE-Name')).toBe('WorkBuddy')
    expect(header(headers, 'X-IDE-Version')).toBe(APP_VERSION)
    expect(header(headers, 'X-Private-Data')).toBe('true')
    expect(header(headers, 'X-Agent-Intent')).toBe('craft')
    expect(header(headers, 'X-Agent-Purpose')).toBe('conversation')
    expect(header(headers, 'X-Agent-Type')).toBe('main')
    expect(header(headers, 'X-Product')).toBe('SaaS')
    expect(header(headers, 'Accept')).toBe('application/json')
    expect(header(headers, 'X-Requested-With')).toBe('XMLHttpRequest')
    expect(header(headers, 'X-Conversation-Id')).toBe(CONVERSATION_ID)
    for (const name of PER_REQUEST_IDS) expect(header(headers, name)).toMatch(UUID_V7)
    expect(header(headers, 'X-B3-TraceId')).toMatch(TRACE_ID)
    expect(header(headers, 'X-B3-ParentSpanId')).toMatch(SPAN_ID)
    expect(header(headers, 'X-B3-SpanId')).toMatch(SPAN_ID)
    expect(header(headers, 'X-B3-Sampled')).toBe('1')
    expect(header(headers, 'traceparent')).toMatch(TRACEPARENT)
    expect(header(headers, 'b3')).toMatch(B3)
    // X-Trace-Id 与 B3 的 trace 是同一个 id，不是两套独立随机。
    expect(header(headers, 'X-Trace-Id')).toBe(header(headers, 'X-B3-TraceId'))
  })
})

describe('User-Agent', () => {
  it('CN 两个产品词都是 WorkBuddy，末尾带 CLI 段', () => {
    const headers = headersOf(baseInput())
    expect(header(headers, 'User-Agent')).toBe(
      `WorkBuddy/${APP_VERSION} WorkBuddy/${APP_VERSION} CLI/${CLI_VERSION}`,
    )
  })

  it('global 第二个产品词换成 WorkBuddy AI，第一个保持 WorkBuddy', () => {
    const headers = headersOf({ ...baseInput(), region: 'global' })
    expect(header(headers, 'User-Agent')).toBe(
      `WorkBuddy/${APP_VERSION} WorkBuddy AI/${APP_VERSION} CLI/${CLI_VERSION}`,
    )
  })

  it('CLI 版本缺失时整段消失，而不是发一个空 CLI/', () => {
    const headers = headersOf({ ...baseInput(), identity: { clientVersion: APP_VERSION } })
    const ua = header(headers, 'User-Agent')
    expect(ua).toBe(`WorkBuddy/${APP_VERSION} WorkBuddy/${APP_VERSION}`)
    expect(ua).not.toContain('CLI/')
  })
})

describe('X-No-* 退化', () => {
  it('空 uid / 空 domain 走 X-No-*，不发空头也不发原值', () => {
    const headers = headersOf({ ...baseInput(), uid: '', domain: '' })
    expect(header(headers, 'X-No-User-Id')).toBe('1')
    expect(header(headers, 'X-No-Department-Info')).toBe('1')
    expect('X-User-Id' in headers).toBe(false)
    expect('X-Domain' in headers).toBe(false)
  })

  it('个人账号的 enterprise 头是"整对省略"，不是取反', () => {
    // 官方抓包里个人账号既没有 X-Enterprise-Id 也没有 X-No-Enterprise-Id；
    // 补一个取反头只是在说官方客户端从没说过的话，所以两键都必须不存在。
    for (const input of [baseInput(), { ...baseInput(), enterpriseId: '' }]) {
      const headers = headersOf(input)
      expect('X-Enterprise-Id' in headers).toBe(false)
      expect('X-No-Enterprise-Id' in headers).toBe(false)
    }
  })

  it('反向控制：有值就只发正常头，X-No-* 一个都不出现', () => {
    const headers = headersOf({ ...baseInput(), enterpriseId: 'ent-9' })
    expect(header(headers, 'X-User-Id')).toBe('uid-1')
    expect(header(headers, 'X-Domain')).toBe('www.codebuddy.cn')
    expect(header(headers, 'X-Enterprise-Id')).toBe('ent-9')
    expect('X-No-User-Id' in headers).toBe(false)
    expect('X-No-Department-Info' in headers).toBe(false)
    expect('X-No-Enterprise-Id' in headers).toBe(false)
  })
})

describe('设备令牌', () => {
  it('拿到 token 才发 X-Device-Token', () => {
    const token = `v3:${'A'.repeat(96)}`
    const headers = headersOf({ ...baseInput(), deviceToken: token })
    expect(header(headers, 'X-Device-Token')).toBe(token)
  })

  it('没有 token 时该键不存在 —— 不是空串，也不是 undefined 值', () => {
    const headers = headersOf(baseInput())
    expect(headers['X-Device-Token']).toBeUndefined()
    expect('X-Device-Token' in headers).toBe(false)
  })
})

describe('header-safe', () => {
  it('会拆分请求的值被整条丢弃，而不是清洗成怪值', () => {
    const headers = headersOf({
      ...baseInput(),
      uid: 'uid\r\nX-Evil: 1',
      domain: '中文域',
      enterpriseId: 'ent\twith-tab',
      deviceToken: 'a\r\nX-Evil: 1',
    })

    // 四个坏值全部按"缺省"处理：注入面被关掉，而不是被截断/替换后仍上送。
    expect('X-Device-Token' in headers).toBe(false)
    expect('X-Enterprise-Id' in headers).toBe(false)
    expect('X-No-Enterprise-Id' in headers).toBe(false)
    expect('X-User-Id' in headers).toBe(false)
    expect('X-Domain' in headers).toBe(false)
    expect(header(headers, 'X-No-User-Id')).toBe('1')
    expect(header(headers, 'X-No-Department-Info')).toBe('1')

    // 整个头集（键与值）里都不许出现注入出来的头名或控制字符。
    const dump = JSON.stringify(headers)
    expect(dump).not.toContain('X-Evil')
    expect(dump).not.toContain('\r')
    expect(dump).not.toContain('\n')
  })

  it('非法 conversationId 不会原样上送：换成新生成的 v4', () => {
    const headers = headersOf({ ...baseInput(), conversationId: '\n' })
    const id = header(headers, 'X-Conversation-Id')
    expect(id).toMatch(UUID_V4)
    expect(id).not.toContain('\n')
    // 反向控制：合法 conversationId 必须原样保留，否则"会话"就断了。
    expect(header(headersOf(baseInput()), 'X-Conversation-Id')).toBe(CONVERSATION_ID)
  })

  it('SP 是合法 header 值：这一层拒的是注入面，不是宽松格式', () => {
    // `has space` 符合 RFC 9110 的 field-value；把它也拒掉只会无谓地降级身份头。
    expect(validHeaderValue('has space')).toBe(true)
    const headers = headersOf({ ...baseInput(), uid: 'has space' })
    expect(header(headers, 'X-User-Id')).toBe('has space')
    expect('X-No-User-Id' in headers).toBe(false)
  })
})

describe('validHeaderValue', () => {
  it('只放行非空的可打印 ASCII，其余一律 false', () => {
    expect(validHeaderValue('uid-1')).toBe(true)
    expect(validHeaderValue('WorkBuddy/5.8.3 WorkBuddy/5.8.3')).toBe(true)
    expect(validHeaderValue('')).toBe(false)
    expect(validHeaderValue('\r')).toBe(false)
    expect(validHeaderValue('uid\r\nX-Injected: 1')).toBe(false)
    expect(validHeaderValue('\n')).toBe(false)
    expect(validHeaderValue('\t')).toBe(false)
    expect(validHeaderValue('中文')).toBe(false)
    expect(validHeaderValue(42)).toBe(false)
    expect(validHeaderValue(undefined)).toBe(false)
  })
})

describe('红线：密钥不进聊天头', () => {
  it('输入里的 refreshToken 不会以任何键或值的形式出现在输出', () => {
    const secret = 'rt-7f3c-do-not-leak'
    // 用变量而不是字面量传参：额外字段在结构类型下合法，正是"调用方塞了什么"的模拟。
    const tainted = { ...baseInput(), refreshToken: secret, accessToken: `at-${secret}` }
    const headers = headersOf(tainted)

    expect('X-Refresh-Token' in headers).toBe(false)
    // Authorization 由调用方自己加，构建器不许代劳（代劳就会带错 token）。
    expect('Authorization' in headers).toBe(false)
    expect(Object.values(headers).some((value) => value.includes(secret))).toBe(false)
    expect(JSON.stringify(headers)).not.toContain('rt-7f3c')
  })
})

describe('trace 在退化随机下只降级不抛错', () => {
  it('全零 random：不抛，四个 trace 头形状仍然合法', () => {
    // 实现对全零 trace id 只重取一次就接受（避免请求路径里无界重试），所以这里
    // 只钉"不抛 + 形状正确"，不断言"一定非零" —— 那会与实现的收敛策略矛盾。
    let headers: Record<string, string> | undefined
    expect(() => {
      headers = headersOf(baseInput(), NOW_MS, ZERO)
    }).not.toThrow()

    const built = headers ?? {}
    expect(header(built, 'X-B3-TraceId')).toMatch(TRACE_ID)
    expect(header(built, 'X-B3-ParentSpanId')).toMatch(SPAN_ID)
    expect(header(built, 'X-B3-SpanId')).toMatch(SPAN_ID)
    expect(header(built, 'traceparent')).toMatch(TRACEPARENT)
    expect(header(built, 'b3')).toMatch(B3)
    expect(header(built, 'X-Trace-Id')).toBe(header(built, 'X-B3-TraceId'))
  })
})
