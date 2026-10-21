/**
 * The international desktop app's version, used as the `/v3/config` UA.
 *
 * The App-shaped catalog is served only to a User-Agent carrying the product
 * name. The 2026-09-11 research recommended the space form `WorkBuddy AI/<v>`;
 * re-measured the same day the *space* form is rejected (HTTP 400, code
 * 12403) while the terse `WorkBuddyAI/<v>` form — with or without the space
 * removed — returns the 21-model App document. The UA is therefore built from
 * the form verified in code, not from the earlier prose.
 *
 * The version is only ever a UA component: a missing App, an unreadable
 * plist, or a bad cached value degrades to the last saved value and finally to
 * a compiled-in constant, and never blocks credential use or the provider.
 *
 * @module dsh-workbuddy-bridge/app-version
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  findWorkBuddyInstall,
  readInstallAppVersion,
  readPlistVersion,
} from './workbuddy-install.ts'

/**
 * Last-resort UA version.
 *
 * The gateway ignores the version number when splitting the UA (research §2.7.2
 * item 2: `CLI/1.0.0`, `CLI/99.0.0` and the real version all return the same
 * document), so this constant is a shape requirement rather than a currency
 * claim. It is *not* used to infer anything about model capabilities.
 */
export const FALLBACK_APP_VERSION = '5.5.2'

/** Basename of the saved version under `$DSH_HOME`. */
export const WORKBUDDY_APP_VERSION_FILENAME = '.workbuddy-ai-version.json'

/** Where the version came from, for `doctor` output. */
export type WorkBuddyAppVersionSource = 'installed' | 'saved' | 'fallback'

/** Resolved version plus provenance. */
export interface AppVersionInfo {
  version: string
  source: WorkBuddyAppVersionSource
  /** Install root the version was read from, when installed (macOS bundle, Windows install dir). */
  bundle?: string
  /** Which layout `bundle` follows; absent when nothing was installed. */
  platform?: 'win32' | 'darwin'
}

/**
 * Whether a string is safe to interpolate into an HTTP header.
 *
 * Strict on purpose: the value reaches a header, so anything that could split
 * the request (CR, LF, spaces beyond the separator) or inject a second UA
 * token must never pass. The App's own version is always `N.N.N` or `N.N.N.N`.
 */
export function validAppVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value)
}

/**
 * Read `CFBundleShortVersionString` out of an `Info.plist`.
 *
 * Parsed as XML rather than grepped, because the plist contains several
 * `<string>` values and a regex would be one unrelated key away from
 * returning the wrong one. A binary plist has no `<dict>` in its bytes and is
 * reported as unreadable (the saved value then applies) rather than guessed at.
 *
 * The parsing itself lives in `workbuddy-install.ts`, which reads the same key
 * for the "is this a WorkBuddy install" question; only the header-safety
 * judgement stays here.
 */
export async function readBundleVersion(plistPath: string): Promise<string | undefined> {
  const version = await readPlistVersion(plistPath)
  return validAppVersion(version) ? version : undefined
}

/**
 * The installed international App's version, or `undefined` when it is not
 * installed (or not readable).
 *
 * Both supported layouts are read through {@link findWorkBuddyInstall}: a macOS
 * `.app` bundle and a Windows install directory. Windows used to return
 * `undefined` here, which meant the catalog User-Agent and the chat identity
 * fell back to compiled-in versions on every Windows machine even when the App
 * was installed — the divergence the 11128 channel check reads as "not the
 * official client".
 */
export async function installedAppVersion(): Promise<
  { version: string; bundle: string; platform: 'win32' | 'darwin' } | undefined
> {
  const install = await findWorkBuddyInstall()
  if (install === undefined) return undefined
  const version = await readInstallAppVersion(install)
  if (!validAppVersion(version)) return undefined
  return { version, bundle: install.root, platform: install.platform }
}

/** Saved-version file path under the Harness home. */
export function appVersionPath(): string {
  return join(resolveDshHome(), WORKBUDDY_APP_VERSION_FILENAME)
}

/** Constructor dependencies; all injectable so tests never touch the real FS. */
export interface ResolveAppVersionOptions {
  /** Installed-version reader; defaults to {@link installedAppVersion}. */
  installed?: () => Promise<{ version: string; bundle: string } | undefined>
  /** Saved-version path; defaults to {@link appVersionPath}. */
  path?: string
  /** Cache writer; defaults to {@link writeFileAtomic} with the plugin's modes. */
  write?: (path: string, content: string) => Promise<void>
}

/**
 * Resolve the UA version: installed App first, then the last saved value, then
 * the compiled-in fallback.
 *
 * A value read from the App is written back immediately, so an uninstalled App
 * or an unreadable plist later still has the last real version to fall back
 * on. The write is best-effort: failing to cache a version must never fail the
 * catalog request that asked for it.
 */
export async function resolveAppVersion(
  options: ResolveAppVersionOptions = {},
): Promise<AppVersionInfo> {
  const path = options.path ?? appVersionPath()
  const installed = await (options.installed ?? installedAppVersion)()
  if (installed !== undefined && validAppVersion(installed.version)) {
    const write =
      options.write ??
      ((target: string, content: string) =>
        writeFileAtomic(target, content, { mode: 0o600, dirMode: 0o700 }))
    try {
      await write(
        path,
        `${JSON.stringify({ version: installed.version, bundle: installed.bundle, observedAt: Date.now() }, null, 2)}\n`,
      )
    } catch {
      // A read-only home is not a reason to serve no catalog.
    }
    return { version: installed.version, source: 'installed', bundle: installed.bundle }
  }
  try {
    const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof saved === 'object' && saved !== null) {
      const version = (saved as Record<string, unknown>)['version']
      if (validAppVersion(version)) return { version, source: 'saved' }
    }
  } catch {
    // Absent or malformed cache: fall through to the compiled-in default.
  }
  return { version: FALLBACK_APP_VERSION, source: 'fallback' }
}

/**
 * Build the App-shaped User-Agent for catalog requests.
 *
 * `WorkBuddyAI/<version>` with no space is the form measured to reach the App
 * document; the space form is rejected with 400/12403. Throws on an invalid
 * version rather than sending a malformed header.
 */
export function appUserAgent(version: string): string {
  if (!validAppVersion(version))
    throw new Error(`invalid WorkBuddy AI version for User-Agent: ${JSON.stringify(version)}`)
  return `WorkBuddyAI/${version}`
}
