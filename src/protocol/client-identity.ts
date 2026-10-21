/**
 * The desktop-client identity chat requests present as (phase 1 of the upstream
 * identity alignment — unit-covered by `tests/client-identity.spec.ts`, and
 * re-checked against the real upstream by `scripts/client-identity-live-matrix.mjs`).
 *
 * Chat and its probe sibling carry the User-Agent shape the official desktop
 * client composes — `WorkBuddy/<v> <product>/<v> CLI/<cli>` — where the
 * product token names the app that owns the region's requests: `WorkBuddy`
 * for CN, `WorkBuddy AI` for international. Versions come from the installed
 * App when it can be read, degrade to a per-region saved value, and finally
 * to a compiled-in constant. A CLI version that does not resolve drops the
 * `CLI/…` token instead of inventing one (the official client's own rule for
 * a missing extension).
 *
 * Scope: chat and probe requests ONLY. Refresh, catalog, and billing keep
 * the headers they have always sent; this phase holds the blast radius to
 * one variable so the live verification matrix stays readable.
 *
 * @module dsh-workbuddy-bridge/client-identity
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  FALLBACK_APP_VERSION,
  resolveAppVersion,
  validAppVersion,
  type AppVersionInfo,
} from '../protocol/app-version.ts'
import {
  findWorkBuddyInstall,
  readInstallAppVersion,
  readInstallCliVersion,
} from './workbuddy-install.ts'
import type { WorkBuddyRegion } from '../protocol/client.ts'

/**
 * Compiled-in CN fallback for the `WorkBuddy/<v>` tokens.
 *
 * Observed on the CN desktop app installed here (research §3.1, verified
 * 2026-09-11); like the international fallback it is a shape requirement,
 * not a currency claim — the gateway has not been observed to branch on it.
 */
export const FALLBACK_CN_APP_VERSION = '5.5.6'

/**
 * Basename of the CN saved-version cache under `$DSH_HOME`.
 *
 * Deliberately not the international `.workbuddy-ai-version.json`: that file
 * feeds the international catalog's User-Agent, and a CN App writing its
 * version into it would relabel that request. The two caches stay isolated
 * the way the per-variant catalog files are.
 */
export const CN_APP_VERSION_FILENAME = '.workbuddy-app-version.json'

/** The resolved identity a chat request presents as. */
export interface ChatIdentity {
  /** Desktop App version; drives both `WorkBuddy/<v>` product tokens. */
  clientVersion: string
  /** Bundled agent-CLI version; absent drops the `CLI/…` UA token. */
  cliVersion?: string
}

/**
 * Whether a value is a CLI version that may reach a header.
 *
 * Tolerates a prerelease suffix (`2.137.1-rc.1`) because the bundled CLI's
 * own metadata uses that spelling; anything with whitespace, CR or LF never
 * passes — the value is interpolated into an HTTP header.
 */
export function validCliVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value)
}

/** macOS App-bundle roots, searched in the order `app-version.ts` uses. */
/**
 * The bundled agent CLI's real version, or `undefined` when it does not resolve.
 *
 * `cli/package.json` ships a `0.0.0` placeholder in `version` with the real
 * version in `publishConfig.customPackage.version`; a valid non-placeholder
 * `version` wins, otherwise the custom-package value applies, and unreadable
 * or invalid metadata yields `undefined` (the caller drops the `CLI/…` UA
 * token rather than guessing).
 *
 * `bundle` is an install root — a `.app` bundle on macOS, an install directory
 * on Windows — and `platform` selects the layout. It defaults to the macOS
 * layout because that is the shape this reader was introduced with and the one
 * the existing fixtures describe.
 */
export async function readCliVersion(
  bundle: string,
  platform: 'win32' | 'darwin' = 'darwin',
): Promise<string | undefined> {
  const version = await readInstallCliVersion({ root: bundle, platform })
  return validCliVersion(version) ? version : undefined
}

/**
 * Build the chat User-Agent for one region.
 *
 * Throws on an invalid version rather than interpolating one into a header;
 * `resolveChatIdentity` never produces such an identity, so the throw is a
 * last gate against future call-site mistakes, not an expected path.
 */
export function chatUserAgent(identity: ChatIdentity, region: WorkBuddyRegion): string {
  if (!validAppVersion(identity.clientVersion)) {
    throw new Error(
      `invalid client version for chat User-Agent: ${JSON.stringify(identity.clientVersion)}`,
    )
  }
  if (identity.cliVersion !== undefined && !validCliVersion(identity.cliVersion)) {
    throw new Error(
      `invalid CLI version for chat User-Agent: ${JSON.stringify(identity.cliVersion)}`,
    )
  }
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`]
  if (identity.cliVersion !== undefined) parts.push(`CLI/${identity.cliVersion}`)
  return parts.join(' ')
}

/** Constructor dependencies; every reader is injectable so tests never touch a real App or home. */
export interface ResolveChatIdentityOptions {
  /** Installed CN desktop reader; defaults to the platform install probe. */
  installedCn?: () => Promise<InstalledApp | undefined>
  /** International version resolver; defaults to `app-version.ts`'s chain. */
  resolveIntl?: () => Promise<AppVersionInfo>
  /** CLI-version reader; defaults to reading the install's `cli/package.json`. */
  cliVersion?: (bundle: string, platform: 'win32' | 'darwin') => Promise<string | undefined>
  /** CN saved-cache path; defaults to `$DSH_HOME/.workbuddy-app-version.json`. */
  cnSavedPath?: string
}

/** A resolved installed App: its version and the root its CLI lives under. */
interface InstalledApp {
  version: string
  bundle: string
  /**
   * Layout of `bundle`. Absent means the macOS `.app` layout — the shape this
   * seam had before Windows discovery existed, kept optional so a reader that
   * only cares about the version does not have to name a platform.
   */
  platform?: 'win32' | 'darwin'
}

/**
 * The installed CN desktop App, or `undefined` when it is not installed.
 *
 * Both layouts resolve through {@link findWorkBuddyInstall}. This used to read
 * macOS bundles only, so a Windows install was invisible and every chat request
 * presented the compiled-in fallback version — one of the differences the
 * upstream's channel check reads as "not the official client".
 */
async function installedCnApp(): Promise<InstalledApp | undefined> {
  const install = await findWorkBuddyInstall()
  if (install === undefined) return undefined
  const version = await readInstallAppVersion(install)
  if (!validAppVersion(version)) return undefined
  return { version, bundle: install.root, platform: install.platform }
}

/** Default CN saved-cache path. */
function cnSavedVersionPath(): string {
  return join(resolveDshHome(), CN_APP_VERSION_FILENAME)
}

/**
 * Resolve the chat identity for one region: installed App → region's saved
 * value → compiled-in fallback. Never throws — a missing App, an unreadable
 * plist, a failed cache write, or a reader that throws outright all degrade
 * to {@link fallbackChatIdentity}; resolution never blocks a message.
 *
 * The production path caches per region (a message must not re-read the
 * install tree); any injected option bypasses the cache entirely so tests
 * with different readers cannot observe each other's resolutions.
 */
export async function resolveChatIdentity(
  region: WorkBuddyRegion,
  options: ResolveChatIdentityOptions = {},
): Promise<ChatIdentity> {
  const injectable =
    options.installedCn !== undefined ||
    options.resolveIntl !== undefined ||
    options.cliVersion !== undefined ||
    options.cnSavedPath !== undefined
  if (!injectable) {
    const cached = cache.get(region)
    if (cached !== undefined) return cached
  }
  let identity: ChatIdentity
  try {
    identity =
      region === 'global' ? await resolveGlobalIdentity(options) : await resolveCnIdentity(options)
  } catch {
    // A reader that throws (unexpected filesystem error, injected test
    // double) must not block a message and must not pin this degraded
    // answer for the process lifetime: return the built-in fallback
    // without caching it, so a later call can resolve properly again.
    return fallbackChatIdentity(region)
  }
  if (!injectable) cache.set(region, identity)
  return identity
}

const cache = new Map<WorkBuddyRegion, ChatIdentity>()

/**
 * The region's compiled-in fallback identity: the desktop form with the
 * built-in version and no `CLI/…` segment. This is the single degraded
 * shape every failure path converges on — a thrown reader, an unreadable
 * bundle, or a missing cache all present this, never the legacy CLI UA.
 */
export function fallbackChatIdentity(region: WorkBuddyRegion): ChatIdentity {
  return { clientVersion: region === 'global' ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION }
}

/** CN: installed `WorkBuddy.app` → CN saved cache → CN fallback. */
async function resolveCnIdentity(options: ResolveChatIdentityOptions): Promise<ChatIdentity> {
  const savedPath = options.cnSavedPath ?? cnSavedVersionPath()
  const installed = await (options.installedCn ?? installedCnApp)()
  if (installed !== undefined && validAppVersion(installed.version)) {
    const cliVersion = await (options.cliVersion ?? readCliVersion)(
      installed.bundle,
      installed.platform ?? 'darwin',
    )
    const identity: ChatIdentity = {
      clientVersion: installed.version,
      ...(cliVersion !== undefined && validCliVersion(cliVersion) ? { cliVersion } : {}),
    }
    // Best-effort remember of the App version only: the CLI version is read
    // live from the bundle whenever the bundle exists, and once the App is
    // gone the plan's degradation omits the `CLI/…` token instead of
    // continuing to claim a version whose source no longer exists.
    try {
      await writeFileAtomic(
        savedPath,
        `${JSON.stringify({ version: identity.clientVersion, observedAt: Date.now() }, null, 2)}\n`,
        { mode: 0o600, dirMode: 0o700 },
      )
    } catch {
      // Identity resolved; losing the memory of it is not a failure.
    }
    return identity
  }
  try {
    const saved: unknown = JSON.parse(await readFile(savedPath, 'utf8'))
    if (typeof saved === 'object' && saved !== null && !Array.isArray(saved)) {
      const document = saved as Record<string, unknown>
      if (validAppVersion(document['version'])) {
        return { clientVersion: document['version'] }
      }
    }
  } catch {
    // Absent or malformed cache: fall through to the compiled-in constant.
  }
  return fallbackChatIdentity('cn')
}

/**
 * International: reuse `app-version.ts`'s installed → saved → fallback chain
 * (its cache format and the catalog's version source stay untouched). The
 * CLI version is read only when that chain reports the installed bundle; a
 * saved or fallback resolution has no bundle path and drops the `CLI/…` token.
 * The CN cache is never read or written on this path.
 */
async function resolveGlobalIdentity(options: ResolveChatIdentityOptions): Promise<ChatIdentity> {
  const info = await (options.resolveIntl ?? resolveAppVersion)()
  const clientVersion = validAppVersion(info.version) ? info.version : FALLBACK_APP_VERSION
  let cliVersion: string | undefined
  if (info.bundle !== undefined) {
    const read = await (options.cliVersion ?? readCliVersion)(
      info.bundle,
      info.platform ?? 'darwin',
    )
    if (read !== undefined && validCliVersion(read)) cliVersion = read
  }
  return { clientVersion, ...(cliVersion === undefined ? {} : { cliVersion }) }
}
