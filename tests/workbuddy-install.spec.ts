import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findWorkBuddyInstall,
  installRootsFromRegistry,
  readInstallAppVersion,
  readInstallCliVersion,
  readPlistVersion,
  readTuringChannelId,
  turingSdkModulePath,
  workBuddyDataRoot,
  type WorkBuddyInstall,
} from '../src/protocol/workbuddy-install.ts'

/**
 * 安装发现与版本读取的离线契约。
 *
 * 纪律：临时目录 + 注入 —— 绝不 spawn 真实 `reg.exe`，也绝不读真实安装目录。
 * `reg query` 的输出是手工构造的文本，两个平台的布局是临时目录里摆出来的文件；
 * 要钉住的是"发现判据"（谁算安装、谁不算）与"布局映射"（两平台只差 Contents 一段）。
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of CLEANUP.splice(0)) await dispose()
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value))
}

/**
 * 按**真实**布局给出各处路径。
 *
 * 刻意不调用被测的 `resourcePath`：两个平台的映射一旦写反，用被测函数搭 fixture 会
 * 让目录跟着错、断言仍然绿。这里的路径必须独立于实现，测试才有判别力。
 */
function layoutOf(root: string, platform: 'win32' | 'darwin') {
  const resources =
    platform === 'darwin' ? join(root, 'Contents', 'Resources') : join(root, 'resources')
  return {
    resources,
    manifest: join(resources, 'install-manifest.json'),
    asar: join(resources, 'app.asar'),
    plist: join(root, 'Contents', 'Info.plist'),
    cliPackage: join(resources, 'app.asar.unpacked', 'cli', 'package.json'),
  }
}

function installAt(root: string, platform: 'win32' | 'darwin'): WorkBuddyInstall {
  return { root, platform }
}

/** 一个 XML `Info.plist`；故意把目标 key 放在别的 `<string>` 之后。 */
function plistWithVersion(version: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleName</key>',
    '  <string>WorkBuddy</string>',
    '  <key>CFBundleShortVersionString</key>',
    `  <string>${version}</string>`,
    '  <key>CFBundleVersion</key>',
    '  <string>9999</string>',
    '</dict>',
    '</plist>',
  ].join('\n')
}

const HKCU_UNINSTALL = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const HKLM_UNINSTALL = 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'

describe('installRootsFromRegistry', () => {
  it('只认 DisplayName 以 WorkBuddy 开头的块，并从 DisplayIcon 的 exe 反推根目录', () => {
    const output = [
      `${HKCU_UNINSTALL}\\WorkBuddy`,
      '    DisplayName    REG_SZ    WorkBuddy 5.8.3',
      '    DisplayIcon    REG_SZ    "E:\\APPS\\WorkBuddy\\WorkBuddy.exe",0',
      '',
      // 名字里没有 WorkBuddy：路径再像也不能算命中。
      `${HKCU_UNINSTALL}\\CodeBuddyHelper`,
      '    DisplayName    REG_SZ    CodeBuddy Helper',
      '    DisplayIcon    REG_SZ    "E:\\APPS\\WorkBuddy\\WorkBuddy.exe",0',
      '',
      // 反向：DisplayName 只是"提到"了 WorkBuddy，仍然是另一个产品的记录。
      `${HKCU_UNINSTALL}\\SomeEditor`,
      '    DisplayName    REG_SZ    SomeEditor for WorkBuddy',
      '    DisplayIcon    REG_SZ    "D:\\Editor\\editor.exe",0',
    ].join('\r\n')

    expect(installRootsFromRegistry(output)).toEqual(['E:\\APPS\\WorkBuddy'])
  })

  it('DisplayIcon 指向 .ico 时回落到 InstallLocation', () => {
    const output = [
      `${HKCU_UNINSTALL}\\WorkBuddy`,
      '    DisplayName    REG_SZ    WorkBuddy 5.8.3',
      '    DisplayIcon    REG_SZ    "C:\\Program Files\\WorkBuddy\\uninstall.ico",0',
      '    InstallLocation    REG_SZ    D:\\Apps\\WorkBuddy',
    ].join('\r\n')

    // 安装器常把 InstallLocation 留空、只写 DisplayIcon；反过来（只有 .ico）时
    // 必须能读 InstallLocation，否则装在别的盘的安装就永远发现不了。
    expect(installRootsFromRegistry(output)).toEqual(['D:\\Apps\\WorkBuddy'])
  })

  it('InstallLocation 直接给 exe 时去掉文件名；同一根只返回一次', () => {
    const output = [
      `${HKCU_UNINSTALL}\\WorkBuddy`,
      '    DisplayName    REG_SZ    WorkBuddy 5.8.3',
      '    DisplayIcon    REG_SZ    "C:\\Program Files\\WorkBuddy\\app.ico",0',
      '    InstallLocation    REG_SZ    "D:\\Apps\\WorkBuddy\\WorkBuddy.exe"',
      '',
      `${HKLM_UNINSTALL}\\WorkBuddy`,
      '    DisplayName    REG_SZ    WorkBuddy 5.8.3',
      '    DisplayIcon    REG_SZ    "D:\\Apps\\WorkBuddy\\WorkBuddy.exe",0',
    ].join('\r\n')

    expect(installRootsFromRegistry(output)).toEqual(['D:\\Apps\\WorkBuddy'])
  })

  it('没有匹配的块时返回空数组（"没装"不是抛错）', () => {
    expect(installRootsFromRegistry('')).toEqual([])
    expect(
      installRootsFromRegistry('ERROR: The system was unable to find the specified key.\r\n'),
    ).toEqual([])
  })
})

describe('findWorkBuddyInstall', () => {
  it('Windows：%LOCALAPPDATA%\\Programs\\WorkBuddy 命中，并回报平台', async () => {
    const localAppData = await tempDir('wb-find-win-')
    const root = join(localAppData, 'Programs', 'WorkBuddy')
    await writeJson(layoutOf(root, 'win32').manifest, { appVersion: '5.8.3' })

    await expect(
      findWorkBuddyInstall({
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData },
        registryRoots: async () => [],
      }),
    ).resolves.toEqual({ root, platform: 'win32' })
  })

  it('resources/app.asar 同样算安装证据（manifest 缺失的安装）', async () => {
    const localAppData = await tempDir('wb-find-asar-')
    const root = join(localAppData, 'Programs', 'WorkBuddy')
    await writeText(layoutOf(root, 'win32').asar, '')

    await expect(
      findWorkBuddyInstall({
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData },
        registryRoots: async () => [],
      }),
    ).resolves.toEqual({ root, platform: 'win32' })
  })

  // macOS 的候选里第一条是真实 /Applications；本机要是真装了，这条 fixture 会被它
  // 抢走，于是跳过而不是读真实安装目录做断言。
  const realMacInstall = process.platform === 'darwin' && existsSync('/Applications/WorkBuddy.app')
  it.skipIf(realMacInstall)(
    'macOS：~/Applications/WorkBuddy.app 命中，且认的是 Contents/Resources 段',
    async () => {
      const home = await tempDir('wb-find-mac-')
      const root = join(home, 'Applications', 'WorkBuddy.app')
      await writeJson(layoutOf(root, 'darwin').manifest, { appVersion: '5.8.3' })
      await writeText(layoutOf(root, 'darwin').plist, plistWithVersion('5.8.3'))

      await expect(findWorkBuddyInstall({ platform: 'darwin', home })).resolves.toEqual({
        root,
        platform: 'darwin',
      })
    },
  )

  it('目录不存在 → undefined（默认目录与注册表都查过才判没装）', async () => {
    const localAppData = await tempDir('wb-find-none-')
    const registryRoots = vi.fn(async () => [])

    await expect(
      findWorkBuddyInstall({
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData },
        registryRoots,
      }),
    ).resolves.toBeUndefined()
    expect(registryRoots).toHaveBeenCalledTimes(1)
  })

  it('不支持的平台直接 undefined，连注册表都不碰', async () => {
    const registryRoots = vi.fn(async () => [])

    await expect(
      findWorkBuddyInstall({ platform: 'linux', registryRoots }),
    ).resolves.toBeUndefined()
    expect(registryRoots).not.toHaveBeenCalled()
  })

  it('装在别的盘：默认目录全不存在时用注册表给出的根', async () => {
    const missing = join(await tempDir('wb-find-env-'), 'no-such-dir')
    const realRoot = await tempDir('wb-find-reg-')
    await writeJson(layoutOf(realRoot, 'win32').manifest, { appVersion: '5.8.3' })

    await expect(
      findWorkBuddyInstall({
        platform: 'win32',
        env: {
          LOCALAPPDATA: missing,
          PROGRAMFILES: missing,
          'PROGRAMFILES(X86)': missing,
        },
        registryRoots: async () => [realRoot],
      }),
    ).resolves.toEqual({ root: realRoot, platform: 'win32' })
  })

  it('默认目录与注册表都命中时优先默认目录（候选顺序即优先级）', async () => {
    const localAppData = await tempDir('wb-find-order-')
    const root = join(localAppData, 'Programs', 'WorkBuddy')
    await writeJson(layoutOf(root, 'win32').manifest, { appVersion: '5.8.3' })
    const registryRoot = await tempDir('wb-find-order-reg-')
    await writeJson(layoutOf(registryRoot, 'win32').manifest, { appVersion: '5.8.3' })

    await expect(
      findWorkBuddyInstall({
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData },
        registryRoots: async () => [registryRoot],
      }),
    ).resolves.toEqual({ root, platform: 'win32' })
  })
})

describe('readInstallAppVersion', () => {
  it('Windows 读 install-manifest.json 的 appVersion', async () => {
    const root = await tempDir('wb-appver-win-')
    await writeJson(layoutOf(root, 'win32').manifest, { appVersion: '5.8.3' })

    await expect(readInstallAppVersion(installAt(root, 'win32'))).resolves.toBe('5.8.3')
  })

  it('macOS 读 Info.plist 的 CFBundleShortVersionString，而不是第一个 <string>', async () => {
    const root = await tempDir('wb-appver-mac-')
    await writeText(layoutOf(root, 'darwin').plist, plistWithVersion('5.8.3'))

    await expect(readInstallAppVersion(installAt(root, 'darwin'))).resolves.toBe('5.8.3')
  })

  it('坏 JSON / 非对象 / 非字符串版本 → undefined', async () => {
    const root = await tempDir('wb-appver-bad-')
    const manifest = layoutOf(root, 'win32').manifest

    await writeText(manifest, '{"appVersion":')
    await expect(readInstallAppVersion(installAt(root, 'win32'))).resolves.toBeUndefined()

    await writeJson(manifest, { appVersion: 583 })
    await expect(readInstallAppVersion(installAt(root, 'win32'))).resolves.toBeUndefined()

    await writeJson(manifest, ['5.8.3'])
    await expect(readInstallAppVersion(installAt(root, 'win32'))).resolves.toBeUndefined()
  })

  it('安装目录不存在 → undefined', async () => {
    const root = await tempDir('wb-appver-missing-')

    await expect(readInstallAppVersion(installAt(root, 'win32'))).resolves.toBeUndefined()
    await expect(readInstallAppVersion(installAt(root, 'darwin'))).resolves.toBeUndefined()
  })
})

describe('readPlistVersion', () => {
  it('只认 CFBundleShortVersionString 对应的 <string>', async () => {
    const dir = await tempDir('wb-plist-')
    const plist = join(dir, 'Info.plist')
    await writeText(plist, plistWithVersion('5.8.3'))
    await expect(readPlistVersion(plist)).resolves.toBe('5.8.3')

    // 有 <string> 但不是目标 key：不能把第一个字符串当成版本。
    const otherKey = join(dir, 'other.plist')
    await writeText(
      otherKey,
      '<plist><dict><key>CFBundleVersion</key><string>9999</string></dict></plist>',
    )
    await expect(readPlistVersion(otherKey)).resolves.toBeUndefined()
    await expect(readPlistVersion(join(dir, 'absent.plist'))).resolves.toBeUndefined()
  })
})

describe('readInstallCliVersion', () => {
  const cliPackage = {
    version: '0.0.0',
    publishConfig: { customPackage: { version: '2.161.0' } },
  }

  it('Windows 布局：0.0.0 占位时取 publishConfig.customPackage.version', async () => {
    const root = await tempDir('wb-cliver-win-')
    await writeJson(layoutOf(root, 'win32').cliPackage, cliPackage)

    await expect(readInstallCliVersion(installAt(root, 'win32'))).resolves.toBe('2.161.0')
  })

  it('macOS 布局：只差 Contents 一段，读到同一份元数据', async () => {
    const root = await tempDir('wb-cliver-mac-')
    await writeJson(layoutOf(root, 'darwin').cliPackage, cliPackage)

    await expect(readInstallCliVersion(installAt(root, 'darwin'))).resolves.toBe('2.161.0')
  })

  it('真实 version 优先于 publishConfig', async () => {
    const root = await tempDir('wb-cliver-priority-')
    await writeJson(layoutOf(root, 'win32').cliPackage, {
      version: '2.1.0',
      publishConfig: { customPackage: { version: '2.161.0' } },
    })

    await expect(readInstallCliVersion(installAt(root, 'win32'))).resolves.toBe('2.1.0')
  })

  it('坏 JSON / 缺 customPackage / 缺文件 → undefined', async () => {
    const root = await tempDir('wb-cliver-bad-')
    const pkg = layoutOf(root, 'win32').cliPackage

    await writeText(pkg, 'not json at all')
    await expect(readInstallCliVersion(installAt(root, 'win32'))).resolves.toBeUndefined()

    await writeJson(pkg, { version: '0.0.0', publishConfig: {} })
    await expect(readInstallCliVersion(installAt(root, 'win32'))).resolves.toBeUndefined()

    const emptyRoot = await tempDir('wb-cliver-missing-')
    await expect(readInstallCliVersion(installAt(emptyRoot, 'darwin'))).resolves.toBeUndefined()
  })
})

describe('turingSdkModulePath', () => {
  it('两种布局都落到 App 自带的 native addon，分隔符随平台', () => {
    const suffix = ['native', 'turing-sdk', 'index.cjs'].join(sep)
    const win = turingSdkModulePath(installAt('C:\\Apps\\WorkBuddy', 'win32'))
    const mac = turingSdkModulePath(installAt('/Applications/WorkBuddy.app', 'darwin'))

    expect(win.endsWith(suffix)).toBe(true)
    expect(mac.endsWith(suffix)).toBe(true)
    expect(win).toContain(`resources${sep}app.asar.unpacked`)
    expect(mac).toContain(`Contents${sep}Resources${sep}app.asar.unpacked`)
    // 映射不许互换：Windows 根下没有 Contents 段。
    expect(win).not.toContain(`Contents${sep}Resources`)
  })
})

describe('readTuringChannelId', () => {
  function cachePath(home: string): string {
    return join(home, '.workbuddy', 'cache', 'acc-product-config-v3.json')
  }

  it('读 App 写下的 product-config 缓存里的正整数 channelId', async () => {
    const home = await tempDir('wb-channel-')
    await writeJson(cachePath(home), { config: { turingSdk: { channelId: 109144 } } })

    await expect(readTuringChannelId(home)).resolves.toBe(109144)
  })

  it('字符串 / 0 / 负数 channelId 一律 undefined（不转换、不猜）', async () => {
    const home = await tempDir('wb-channel-')

    await writeJson(cachePath(home), { config: { turingSdk: { channelId: '109144' } } })
    await expect(readTuringChannelId(home)).resolves.toBeUndefined()

    await writeJson(cachePath(home), { config: { turingSdk: { channelId: 0 } } })
    await expect(readTuringChannelId(home)).resolves.toBeUndefined()

    await writeJson(cachePath(home), { config: { turingSdk: { channelId: -1 } } })
    await expect(readTuringChannelId(home)).resolves.toBeUndefined()
  })

  it('缺文件 / 坏 JSON / 缺 config 段 → undefined', async () => {
    const bare = await tempDir('wb-channel-bare-')
    await expect(readTuringChannelId(bare)).resolves.toBeUndefined()

    const home = await tempDir('wb-channel-bad-')
    await writeText(cachePath(home), '{"config":')
    await expect(readTuringChannelId(home)).resolves.toBeUndefined()

    await writeJson(cachePath(home), { config: { turingSdk: {} } })
    await expect(readTuringChannelId(home)).resolves.toBeUndefined()
  })
})

describe('workBuddyDataRoot', () => {
  it('数据根落在给定 home 的 .workbuddy 下', () => {
    const home = join('/home', 'example')
    expect(workBuddyDataRoot(home)).toBe(join(home, '.workbuddy'))
  })
})
