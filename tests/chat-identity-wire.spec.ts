import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/credential/store.ts'
import { WorkBuddyUpstreamClient } from '../src/protocol/client.ts'
import type { ChatIdentity } from '../src/protocol/client-identity.ts'

/**
 * Outbound wire pin for the phase-1 chat identity (plan §3, 阶段一离线检查):
 * capture the exact `(url, init)` the client hands to `fetch` and assert that
 * chat and probe present the desktop UA while everything else — the shared
 * header family, the body shapes, refresh, catalog, and billing — stays
 * byte-for-byte what it has always been.
 */

const CN: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

/** Deterministic identity so assertions never depend on the machine's Apps. */
const IDENTITY: ChatIdentity = { clientVersion: '5.5.6', cliVersion: '2.137.1' }

/** Deterministic conversation id, so the header can be asserted verbatim. */
const CONVERSATION_ID = '6ca142f8-d1cc-4353-9aac-ca6baa5c659b'

/**
 * A client whose identity is fixed and whose device token is absent.
 *
 * The token reader is injected even here, where the answer is "none": the
 * default reader probes the installed App and loads its native SDK, and a wire
 * test must never touch a real install (nor leave the answer to the machine it
 * happens to run on).
 */
function client(token?: string): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({
    resolveChatIdentity: async () => IDENTITY,
    resolveDeviceToken: async () => token,
    conversationId: CONVERSATION_ID,
  })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub fetch and return a probe for the last (url, init) pair it received. */
function captureFetch(body: string, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => fakeResponse(body, ok, status))
  vi.stubGlobal('fetch', fetchMock)
  return {
    last: () => {
      expect(fetchMock).toHaveBeenCalled()
      return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [
        string,
        RequestInit,
      ]
    },
  }
}

describe('chatStream identity', () => {
  it('presents the official gateway identity and never the browser-ish family', async () => {
    const wire = captureFetch('{}')
    const result = await client().chatStream(
      CN,
      JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(result.ok).toBe(true)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    expect(headers['Authorization']).toBe('Bearer at')
    // The official desktop client's channel identity, header by header.
    expect(headers['x-codebuddy-request']).toBe('1')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe('5.5.6')
    expect(headers['X-Private-Data']).toBe('true')
    expect(headers['X-Agent-Intent']).toBe('craft')
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-Agent-Type']).toBe('main')
    expect(headers['X-Product']).toBe('SaaS')
    expect(headers['Accept']).toBe('application/json')
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(headers['X-User-Id']).toBe('uid-1')
    // The official client omits the enterprise pair entirely for a personal
    // account; the plugin used to send `X-No-Enterprise-Id: 1`, which is a
    // statement the official client never makes.
    expect(headers['X-No-Enterprise-Id']).toBeUndefined()
    expect(headers['X-Enterprise-Id']).toBeUndefined()
    expect(headers['X-Domain']).toBe('www.codebuddy.cn')
    expect(headers['X-Conversation-Id']).toBe(CONVERSATION_ID)
    // Per-request ids: shape only, never a literal (they differ every call).
    expect(headers['X-Request-Id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(headers['acp-connection-id']).toMatch(/^[0-9a-f-]{36}$/u)
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u)
    expect(headers['b3']).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/u)
    expect(headers['X-B3-Sampled']).toBe('1')
    // No device token: the header is omitted, never empty.
    expect(headers['X-Device-Token']).toBeUndefined()
    // The official client sends no Origin/Referer — Node does not add CORS
    // headers, and the plugin used to point them at a different product domain.
    expect(headers['Origin']).toBeUndefined()
    expect(headers['Referer']).toBeUndefined()
    expect(headers['X-Refresh-Token']).toBeUndefined()
    // The body is normalized at this layer for both regions (issue #13), so the
    // CN wire carries the forced `stream: true` rather than the caller's bytes.
    // Nothing else is added: the payload keeps its model and messages as sent.
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
  })

  it('carries the device token when one could be produced', async () => {
    const token = `v3:${'A'.repeat(1054)}`
    const wire = captureFetch('{}')
    await client(token).chatStream(
      CN,
      JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    )
    const [, init] = wire.last()
    const headers = init.headers as Record<string, string>
    expect(headers['X-Device-Token']).toBe(token)
  })

  it('names the international product in the UA and still prepends the first system message', async () => {
    const wire = captureFetch('{}')
    const result = await client().chatStream(
      GLOBAL,
      JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(result.ok).toBe(true)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/2.137.1')
    const body = JSON.parse(init.body as string) as { messages: { role: string }[] }
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[1]?.role).toBe('user')
  })
})

describe('probeEffort identity', () => {
  it('shares the chat identity rule — same UA family, CN probe shape', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await client().probeEffort(CN, 'model-x', 'low', new AbortController().signal)
    const [, init] = wire.last()
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    const body = JSON.parse(init.body as string) as {
      messages: { role: string }[]
      max_tokens: number
      reasoning_effort: string
    }
    expect(body.messages[0]?.role).toBe('user')
    expect(body.max_tokens).toBe(1)
    expect(body.reasoning_effort).toBe('low')
  })

  it('uses the international UA with the probe-only system and token floor', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await client().probeEffort(GLOBAL, 'model-x', undefined, new AbortController().signal)
    const [, init] = wire.last()
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/2.137.1')
    const body = JSON.parse(init.body as string) as {
      messages: { role: string }[]
      max_tokens: number
    }
    expect(body.messages[0]?.role).toBe('system')
    expect(body.max_tokens).toBe(16)
    expect('reasoning_effort' in body).toBe(false)
  })

  it('still constructs chat and probe requests, in the desktop fallback form, when the resolver throws', async () => {
    const throwing = new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => {
        throw new Error('boom')
      },
      resolveDeviceToken: async () => undefined,
      conversationId: CONVERSATION_ID,
    })
    const chatWire = captureFetch('{}')
    const chat = await throwing.chatStream(
      CN,
      JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(chat.ok).toBe(true)
    expect((chatWire.last()[1].headers as Record<string, string>)['User-Agent']).toBe(
      'WorkBuddy/5.5.6 WorkBuddy/5.5.6',
    )

    const probeWire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    const probe = await throwing.probeEffort(GLOBAL, 'model-x', 'low', new AbortController().signal)
    expect(probe.status).toBe(400)
    expect((probeWire.last()[1].headers as Record<string, string>)['User-Agent']).toBe(
      'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2',
    )
  })
})

describe('unchanged paths (regression pin)', () => {
  it('refresh keeps the CLI-form UA, the workbuddy source, and the shared family', async () => {
    const wire = captureFetch(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } }))
    await client().refreshToken(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    expect(headers['X-Auth-Refresh-Source']).toBe('workbuddy')
    expect(headers['X-Refresh-Token']).toBe('rt')
    expect(headers['Origin']).toBe('https://www.codebuddy.cn')
  })

  it('CN catalog keeps the CLI-form UA', async () => {
    const wire = captureFetch(
      JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {
          models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }],
          agents: [{ name: 'cli', models: ['m'] }],
        },
      }),
    )
    await client().fetchModels(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/console/enterprises/personal/models')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(
      'CLI/2.63.2 CodeBuddy/2.63.2',
    )
  })

  it('international catalog keeps the no-space App-form UA', async () => {
    const wire = captureFetch(
      JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {
          models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }],
          agents: [{ name: 'cli', models: ['m'] }],
        },
      }),
    )
    const intlClient = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => ({ version: '5.5.2', source: 'installed', bundle: '/x' }),
      resolveChatIdentity: async () => IDENTITY,
    })
    await intlClient.fetchModels(GLOBAL)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v3/config')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('WorkBuddyAI/5.5.2')
  })

  it('billing stays untouched by the identity change', async () => {
    const wire = captureFetch(
      JSON.stringify({
        code: 0,
        msg: 'ok',
        data: { Response: { Data: { Accounts: [] } } },
      }),
    )
    await client().fetchCredits(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.codebuddy.cn/v2/billing/meter/get-user-resource')
    expect((init.headers as Record<string, string>)['User-Agent']).toBeUndefined()
  })
})
