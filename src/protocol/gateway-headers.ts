/**
 * The gateway identity a chat request presents as — the header set the official
 * WorkBuddy desktop client sends to `/v2/chat/completions`.
 *
 * Phase 1 of the upstream identity alignment (`client-identity.ts`) made the
 * User-Agent look like the desktop App's. That was one variable, verified alone.
 * The upstream then began rejecting requests that carry the UA but not the rest
 * of the client identity: `400 {"code":11128,"msg":"Illegal API invocation from
 * an unapproved channel"}`. This module is phase 2 — the remaining identity
 * surface, still scoped to chat and probe only.
 *
 * The shape comes from a captured request of the official desktop client. Two
 * properties of that capture drive the design:
 *
 * - **Almost every id is per-request.** Conversation, message, request, root and
 *   ACP-connection ids are all distinct, and the trace headers carry fresh
 *   random hex. So this module owns id generation instead of taking ids from the
 *   caller, and only the conversation id is allowed to be supplied (a
 *   conversation is longer-lived than a message).
 * - **The official client sends no `Origin`/`Referer`.** Node-side requests do
 *   not get browser CORS headers, and the plugin used to add them pointing at a
 *   *different product's* origin, which is exactly the kind of thing a channel
 *   check reads as "not us". The chat header set therefore leaves them out.
 *
 * Invariants this module must keep (pinned by `tests/gateway-headers.spec.ts`):
 *
 * 1. Every value is header-safe. A value that could split the request is never
 *    emitted; the offending header is omitted rather than sanitised, so a broken
 *    input degrades the request instead of corrupting it.
 * 2. The refresh token never appears here. Chat carries the access token and
 *    nothing else secret.
 * 3. Building never throws. A message must not fail because an identity could
 *    not be resolved — a missing header is a degraded request, a thrown error is
 *    a dead one.
 *
 * @module dsh-workbuddy-bridge/gateway-headers
 */

import { randomFillSync } from 'node:crypto'
import { chatUserAgent, type ChatIdentity } from './client-identity.ts'
import type { WorkBuddyRegion } from './client.ts'

/** A value that may reach a header: printable ASCII, no separators, no control bytes. */
export function validHeaderValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    /^[\x20-\x7E]+$/u.test(value) &&
    !/[\r\n]/u.test(value)
  )
}

/** Bytes for one id; injectable so tests are deterministic. */
export type RandomBytes = (length: number) => Uint8Array

/** Default randomness: a CSPRNG. */
function defaultRandom(length: number): Uint8Array {
  return randomFillSync(new Uint8Array(length))
}

/** Lower-case hex of `bytes`. */
function hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * A UUIDv7 string: 48-bit big-endian milliseconds, then version/variant, then
 * randomness.
 *
 * The official client's per-request ids are UUIDv7 — the version nibble is `7`
 * and the leading hex tracks wall-clock time — so a v4 would not match the
 * shape a channel check may be looking at. Time-ordered ids are also what makes
 * the capture's ids sortable.
 */
export function uuidv7(nowMs: number, random: RandomBytes = defaultRandom): string {
  const bytes = random(16)
  const time = Math.max(0, Math.floor(nowMs))
  // 48-bit timestamp, most significant first.
  bytes[0] = Math.floor(time / 2 ** 40) & 0xff
  bytes[1] = Math.floor(time / 2 ** 32) & 0xff
  bytes[2] = Math.floor(time / 2 ** 24) & 0xff
  bytes[3] = Math.floor(time / 2 ** 16) & 0xff
  bytes[4] = Math.floor(time / 2 ** 8) & 0xff
  bytes[5] = time & 0xff
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const text = hex(bytes)
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}

/** A UUIDv4 string: the shape the official client's conversation id has. */
export function uuidv4(random: RandomBytes = defaultRandom): string {
  const bytes = random(16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const text = hex(bytes)
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}

/** What one chat request's identity needs. */
export interface GatewayIdentity {
  region: WorkBuddyRegion
  /** Desktop identity: drives the UA and `X-IDE-Version`. */
  identity: ChatIdentity
  /** Account id; an empty uid switches the pair over to the `X-No-*` form. */
  uid: string
  /** Enterprise tenant, when the account has one. */
  enterpriseId?: string
  /** Login domain; an empty domain switches to `X-No-Department-Info`. */
  domain: string
  /** Device token from the App's Turing SDK, when it could be produced. */
  deviceToken?: string
  /** Long-lived conversation id; generated when the caller has none. */
  conversationId?: string
  /** Wall clock for the time-ordered ids; defaults to `Date.now()`. */
  nowMs?: number
  /** Randomness; defaults to a CSPRNG. */
  random?: RandomBytes
}

/** Builder options; every dependency injectable so tests are deterministic. */
export interface GatewayHeaderOptions {
  nowMs?: number
  random?: RandomBytes
}

/**
 * The full chat/probe header set.
 *
 * The order of the spreads is the contract: `Authorization` is added by the
 * caller afterwards, and nothing here may overwrite it or introduce the refresh
 * token. Optional headers are *omitted* when their value is unusable
 * (`exactOptionalPropertyTypes` also forbids the `key: undefined` spelling).
 */
export function buildGatewayHeaders(
  input: GatewayIdentity,
  options: GatewayHeaderOptions = {},
): Record<string, string> {
  const random = options.random ?? input.random ?? defaultRandom
  const nowMs = options.nowMs ?? input.nowMs ?? Date.now()
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Conversation-Id': validHeaderValue(input.conversationId)
      ? input.conversationId
      : uuidv4(random),
    'X-Conversation-Request-Id': uuidv7(nowMs, random),
    'X-Conversation-Message-Id': uuidv7(nowMs, random),
    'X-Request-Id': uuidv7(nowMs, random),
    'X-Root-Request-Id': uuidv7(nowMs, random),
    'acp-connection-id': uuidv7(nowMs, random),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'x-codebuddy-request': '1',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': input.identity.clientVersion,
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
  }
  const userAgent = chatUserAgent(input.identity, input.region)
  if (validHeaderValue(userAgent)) headers['User-Agent'] = userAgent
  if (validHeaderValue(input.deviceToken)) headers['X-Device-Token'] = input.deviceToken
  if (validHeaderValue(input.uid)) headers['X-User-Id'] = input.uid
  else headers['X-No-User-Id'] = '1'
  // The official client sends neither member of the enterprise pair for a
  // personal account (its capture carries no X-Enterprise-Id and no
  // X-No-Enterprise-Id), so an absent tenant is omitted rather than negated:
  // a negated header is a statement the official client never makes.
  if (validHeaderValue(input.enterpriseId)) headers['X-Enterprise-Id'] = input.enterpriseId
  if (validHeaderValue(input.domain)) headers['X-Domain'] = input.domain
  else headers['X-No-Department-Info'] = '1'
  const trace = randomTrace(random)
  headers['traceparent'] = trace.traceparent
  headers['b3'] = trace.b3
  headers['X-B3-TraceId'] = trace.traceId
  headers['X-B3-ParentSpanId'] = trace.parentSpanId
  headers['X-B3-SpanId'] = trace.spanId
  headers['X-B3-Sampled'] = '1'
  headers['X-Trace-Id'] = trace.traceId
  return headers
}

/** The trace header family in one place: W3C `traceparent` plus the B3 spelling. */
function randomTrace(random: RandomBytes): {
  traceparent: string
  b3: string
  traceId: string
  spanId: string
  parentSpanId: string
} {
  // The trace id must not be all zeroes; regenerate once, then accept, so a bad
  // CSPRNG can never turn into an endless loop in a request path.
  let traceBytes = random(16)
  if (traceBytes.every((byte) => byte === 0)) traceBytes = random(16)
  const spanBytes = random(8)
  const parentBytes = random(8)
  const traceId = hex(traceBytes)
  const spanId = hex(spanBytes)
  const parentSpanId = hex(parentBytes)
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    traceId,
    spanId,
    parentSpanId,
  }
  // `nowMs` is part of the signature for callers that want time-correlated
  // traces later; the W3C fields themselves carry no timestamp today.
}

