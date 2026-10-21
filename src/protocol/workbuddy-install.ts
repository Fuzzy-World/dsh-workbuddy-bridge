/**
 * The WorkBuddy desktop App's install root, and the app/CLI versions it carries.
 *
 * Everything the chat identity and the device-token provider need to present the
 * official client's shape starts here: the version tokens in the User-Agent, the
 * bundled CLI's version, and the path of the App's own native Turing SDK module.
 *
 * Why a separate module: the two regions resolve the same facts through the same
 * platform strategies, and the macOS-only readers these replace could not see a
 * Windows install at all — on Windows every chat request therefore presented the
 * compiled-in fallback version instead of the installed one.
 *
 * @module dsh-workbuddy-bridge/workbuddy-install
 */

import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `reg.exe` by absolute path: never resolved through `PATH`, which a user can change. */
const REG_BIN = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\reg.exe`

/** Hives searched for the uninstall record; per-user first, then machine-wide. */
const WINDOWS_UNINSTALL_HIVES: readonly string[] = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/** One `reg query` step's own limit; the whole search stays well under a message's budget. */
const REGISTRY_STEP_TIMEOUT_MS = 3_000
const REGISTRY_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * An installed WorkBuddy desktop App.
 *
 * `root` is the directory that holds `resources/` on Windows, and the `.app`
 * bundle itself on macOS — the two layouts differ by one `Contents` segment, so
 * keeping the platform beside the path is what lets {@link resourcePath} answer
 * for both without a second field.
 */
export interface WorkBuddyInstall {
  root: string
  platform: 'win32' | 'darwin'
}

/** Seams the discovery runs through, so tests never touch a real install or spawn `reg.exe`. */
export interface InstallDiscoveryOptions {
  /** Platform to resolve for; defaults to the running one. */
  platform?: NodeJS.Platform
  /** Environment used for the platform-default candidates; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Home directory used for the per-user candidates; defaults to `os.homedir()`. */
  home?: string
  /** Registry-discovered roots; defaults to a bounded `reg query`. */
  registryRoots?: () => Promise<readonly string[]>
}

/** Whether `path` exists; any error (including a permission denial) reads as "no". */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * A path inside the App's `resources/` directory for either platform layout.
 *
 * Windows installs put `resources/` directly under an install root; a macOS
 * bundle puts it under `Contents/`. Callers name the resource, not the layout.
 */
export function resourcePath(install: WorkBuddyInstall, ...segments: string[]): string {
  return install.platform === 'darwin'
    ? join(install.root, 'Contents', 'Resources', ...segments)
    : join(install.root, 'resources', ...segments)
}

/**
 * Roots named by one `reg query` dump, in listing order.
 *
 * `reg query <hive> /s /f WorkBuddy` prints one block per matching key: a
 * `HKEY_…` header, then indented `Name    REG_SZ    value` lines. The identity
 * proof is `DisplayName` starting with `WorkBuddy` — the search also matches the
 * product name inside *other* values, so a block that merely mentions it must
 * not count. The location comes from `DisplayIcon` first because that is the
 * field that actually carries the path: installers here have been observed
 * writing the app to a drive other than `%LOCALAPPDATA%` and leaving
 * `InstallLocation` empty.
 *
 * Deliberately a local copy of the parser in `credential/at-rest.ts`: importing
 * that module from here would close a runtime import cycle
 * (`client.ts` → this file → `at-rest.ts` → `client.ts`), because `at-rest.ts`
 * exports its key provider alongside its parser. Only the install-root question
 * is answered here, not the key-transport one.
 */
export function installRootsFromRegistry(output: string): string[] {
  const roots: string[] = []
  let name: string | undefined
  let icon: string | undefined
  let location: string | undefined
  const flush = (): void => {
    if (name !== undefined && /^WorkBuddy\b/u.test(name)) {
      const root = rootOfIcon(icon) ?? rootOfLocation(location)
      if (root !== undefined && !roots.includes(root)) roots.push(root)
    }
    name = undefined
    icon = undefined
    location = undefined
  }
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('HKEY_')) {
      flush()
      continue
    }
    const field = /^\s+(\S+)\s+REG_[A-Z_]+\s+(.*)$/u.exec(line)
    if (field === null) continue
    const key = field[1] ?? ''
    const value = (field[2] ?? '').trim()
    if (key === 'DisplayName') name = value
    else if (key === 'DisplayIcon') icon = value
    else if (key === 'InstallLocation') location = value
  }
  flush()
  return roots
}

/** Strip the quotes and trailing `,<icon index>` that `reg` wraps a path value in. */
function unwrapRegistryPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const path = value
    .trim()
    .replace(/^"(.*)"(?:,-?\d+)?$/u, '$1')
    .replace(/,-?\d+$/u, '')
  return path === '' ? undefined : path
}

/** The install directory `DisplayIcon` points at, or `undefined` when it names something else. */
function rootOfIcon(value: string | undefined): string | undefined {
  const path = unwrapRegistryPath(value)
  if (path === undefined || !/\.exe$/iu.test(path)) return undefined
  return path.replace(/[\\/][^\\/]*$/u, '')
}

/** The directory `InstallLocation` names, or `undefined` when it names nothing. */
function rootOfLocation(value: string | undefined): string | undefined {
  const path = unwrapRegistryPath(value)
  if (path === undefined) return undefined
  return /\.exe$/iu.test(path) ? path.replace(/[\\/][^\\/]*$/u, '') : path
}

/**
 * Roots named by the uninstall registry on Windows.
 *
 * A hive that cannot be read at all contributes nothing rather than failing the
 * search: this is a best-effort enrichment on top of the platform defaults, and
 * a missing discovery must degrade the User-Agent, never block a message.
 */
async function windowsRegistryRoots(): Promise<readonly string[]> {
  const found: string[] = []
  for (const hive of WINDOWS_UNINSTALL_HIVES) {
    const output = await new Promise<string>((resolve) => {
      execFile(
        REG_BIN,
        ['query', hive, '/s', '/f', 'WorkBuddy'],
        {
          maxBuffer: REGISTRY_MAX_OUTPUT_BYTES,
          timeout: REGISTRY_STEP_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          // `reg` reports "nothing matched" as exit code 1 in two shapes, both of
          // which are answers about this hive; only a killed process or one that
          // never started means "we could not check".
          if (error === null || error === undefined) resolve(stdout)
          else if (error.killed !== true && typeof error.code !== 'string') resolve(stdout)
          else resolve('')
        },
      )
    })
    found.push(...installRootsFromRegistry(output))
  }
  return found
}

/** Candidate install roots for this platform, most-likely first. */
async function candidateRoots(
  platform: 'win32' | 'darwin',
  env: NodeJS.ProcessEnv,
  home: string,
  registryRoots: () => Promise<readonly string[]>,
): Promise<string[]> {
  const roots: string[] = []
  if (platform === 'darwin') {
    roots.push(join('/Applications', 'WorkBuddy.app'), join(home, 'Applications', 'WorkBuddy.app'))
  } else {
    const localAppData = env['LOCALAPPDATA']
    if (localAppData !== undefined && localAppData !== '') {
      roots.push(join(localAppData, 'Programs', 'WorkBuddy'))
    }
    const programFiles = env['PROGRAMFILES']
    if (programFiles !== undefined && programFiles !== '') {
      roots.push(join(programFiles, 'WorkBuddy'))
    }
    const programFilesX86 = env['PROGRAMFILES(X86)']
    if (programFilesX86 !== undefined && programFilesX86 !== '') {
      roots.push(join(programFilesX86, 'WorkBuddy'))
    }
    // The registry is consulted last but matters most on machines whose app is
    // installed on another drive: `%LOCALAPPDATA%\Programs` is only a default.
    for (const root of await registryRoots()) roots.push(root)
  }
  return roots
}

/** Whether a directory looks like a WorkBuddy install of this platform's layout. */
async function looksLikeInstall(root: string, platform: 'win32' | 'darwin'): Promise<boolean> {
  const install: WorkBuddyInstall = { root, platform }
  // `install-manifest.json` is written by the installer; the asar is the payload
  // every layout carries. Either proves the directory, not just the name.
  if (await exists(resourcePath(install, 'install-manifest.json'))) return true
  return exists(resourcePath(install, 'app.asar'))
}

/**
 * The installed App, or `undefined` when it is not installed (or not readable).
 *
 * Never throws: a discovery that fails is "we could not tell", and every caller
 * treats that exactly like "not installed" by falling back to a saved or
 * compiled-in version.
 */
export async function findWorkBuddyInstall(
  options: InstallDiscoveryOptions = {},
): Promise<WorkBuddyInstall | undefined> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' && platform !== 'darwin') return undefined
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  try {
    const roots = await candidateRoots(
      platform,
      env,
      home,
      options.registryRoots ?? windowsRegistryRoots,
    )
    for (const root of roots) {
      if (await looksLikeInstall(root, platform)) return { root, platform }
    }
  } catch {
    // A broken discovery is not a reason to fail a message.
  }
  return undefined
}

/**
 * The installed App's display version, unvalidated.
 *
 * Windows reads `install-manifest.json`; macOS reads the bundle's Info.plist.
 * The value is returned raw so callers keep owning the "is this safe to put in
 * a header" decision (`validAppVersion`) — this module knows where the version
 * is, not what counts as one.
 */
export async function readInstallAppVersion(
  install: WorkBuddyInstall,
): Promise<string | undefined> {
  if (install.platform === 'darwin') {
    return readPlistVersion(join(install.root, 'Contents', 'Info.plist'))
  }
  try {
    const document: unknown = JSON.parse(
      await readFile(resourcePath(install, 'install-manifest.json'), 'utf8'),
    )
    if (typeof document !== 'object' || document === null || Array.isArray(document))
      return undefined
    const version = (document as Record<string, unknown>)['appVersion']
    return typeof version === 'string' ? version.trim() : undefined
  } catch {
    return undefined
  }
}

/** `CFBundleShortVersionString` out of an XML `Info.plist`, or `undefined`. */
export async function readPlistVersion(plistPath: string): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(plistPath, 'utf8')
  } catch {
    return undefined
  }
  const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(
    text,
  )
  return match?.[1]?.trim()
}

/**
 * The bundled agent CLI's version, unvalidated, or `undefined` when it does not resolve.
 *
 * `cli/package.json` ships a `0.0.0` placeholder in `version` with the real
 * version in `publishConfig.customPackage.version`; a non-placeholder `version`
 * wins, otherwise the custom-package value applies. Like the App version, the
 * result is raw and the caller decides whether it may reach a header.
 */
export async function readInstallCliVersion(
  install: WorkBuddyInstall,
): Promise<string | undefined> {
  let document: unknown
  try {
    document = JSON.parse(
      await readFile(resourcePath(install, 'app.asar.unpacked', 'cli', 'package.json'), 'utf8'),
    )
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
  const pkg = document as Record<string, unknown>
  const declared = pkg['version']
  if (typeof declared === 'string' && declared.trim() !== '' && declared.trim() !== '0.0.0') {
    return declared.trim()
  }
  const publishConfig = pkg['publishConfig']
  if (typeof publishConfig !== 'object' || publishConfig === null || Array.isArray(publishConfig)) {
    return undefined
  }
  const custom = (publishConfig as Record<string, unknown>)['customPackage']
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) return undefined
  const version = (custom as Record<string, unknown>)['version']
  return typeof version === 'string' && version.trim() !== '' ? version.trim() : undefined
}

/**
 * Absolute path of the App's own native Turing SDK module.
 *
 * Passed to the device-token provider rather than required here: this module is
 * about where things are, and only the provider decides whether loading a native
 * addon is acceptable right now.
 */
export function turingSdkModulePath(install: WorkBuddyInstall): string {
  return resourcePath(install, 'app.asar.unpacked', 'native', 'turing-sdk', 'index.cjs')
}

/** The App's user-data root; defaults to `~/.workbuddy`. */
export function workBuddyDataRoot(home?: string): string {
  return join(home ?? homedir(), '.workbuddy')
}

/**
 * The Turing channel id the installed App was configured with, or `undefined`.
 *
 * The value is injected at run time: it is not in `install-manifest.json` nor in
 * `cli/product.json`, only in the product-config cache the App writes under
 * `cache/`. A missing or malformed cache is "unknown", and the caller falls back
 * to the domestic default it observed in this build.
 */
export async function readTuringChannelId(home?: string): Promise<number | undefined> {
  const path = join(workBuddyDataRoot(home), 'cache', 'acc-product-config-v3.json')
  try {
    const document: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof document !== 'object' || document === null || Array.isArray(document))
      return undefined
    const config = (document as Record<string, unknown>)['config']
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined
    const turing = (config as Record<string, unknown>)['turingSdk']
    if (typeof turing !== 'object' || turing === null || Array.isArray(turing)) return undefined
    const channelId = (turing as Record<string, unknown>)['channelId']
    return typeof channelId === 'number' && Number.isInteger(channelId) && channelId > 0
      ? channelId
      : undefined
  } catch {
    return undefined
  }
}
