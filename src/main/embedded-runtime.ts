import * as fs from 'fs'
import * as path from 'path'

export interface EmbeddedRuntimeSpec {
  schemaVersion: 1
  runtimeId: string
  platform: 'linux'
  arch: 'x64'
  nodeVersion: string
  pnpmVersion: string
  dshVersion: string
  archiveName: string
  archiveSize: number
  archiveSha256: string
  archivePath: string
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manifest 根节点不是对象')
  }
  return value as Record<string, unknown>
}

function expectString(
  manifest: Record<string, unknown>,
  name: string,
  pattern: RegExp,
): string {
  const value = manifest[name]
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`manifest.${name} 无效`)
  }
  return value
}

/**
 * Locate the generated runtime in the source tree for development, or beside
 * app.asar after electron-builder copies it with extraResources.
 */
export function embeddedRuntimeDirectory(
  appPath: string,
  resourcesPath: string,
  isPackaged: boolean,
): string {
  return isPackaged ? path.join(resourcesPath, 'runtime') : path.join(appPath, 'runtime')
}

/** Validate the small manifest and archive size before handing it to WSL. */
export function loadEmbeddedRuntime(runtimeDirectory: string): EmbeddedRuntimeSpec {
  const manifestPath = path.join(runtimeDirectory, 'manifest.json')
  let manifest: Record<string, unknown>
  try {
    manifest = expectRecord(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown)
  } catch (err) {
    throw new Error(`无法读取内嵌运行时 manifest（${manifestPath}）：${(err as Error).message}`)
  }

  if (manifest.schemaVersion !== 1) throw new Error('内嵌运行时 manifest 版本不受支持')
  if (manifest.platform !== 'linux' || manifest.arch !== 'x64') {
    throw new Error('内嵌运行时必须是 linux-x64')
  }

  const runtimeId = expectString(manifest, 'runtimeId', /^[a-z0-9][a-z0-9._-]+$/)
  const nodeVersion = expectString(manifest, 'nodeVersion', /^\d+\.\d+\.\d+$/)
  const pnpmVersion = expectString(manifest, 'pnpmVersion', /^\d+\.\d+\.\d+$/)
  const dshVersion = expectString(
    manifest,
    'dshVersion',
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  )
  const archiveName = expectString(
    manifest,
    'archiveName',
    /^[a-z0-9][a-z0-9._-]+\.tar\.gz$/,
  )
  if (path.basename(archiveName) !== archiveName) throw new Error('manifest.archiveName 不是文件名')
  const archiveSha256 = expectString(manifest, 'archiveSha256', /^[0-9a-f]{64}$/)
  const archiveSize = manifest.archiveSize
  if (!Number.isSafeInteger(archiveSize) || (archiveSize as number) <= 0) {
    throw new Error('manifest.archiveSize 无效')
  }

  const archivePath = path.resolve(runtimeDirectory, archiveName)
  let stat: fs.Stats
  try {
    stat = fs.statSync(archivePath)
  } catch (err) {
    throw new Error(`找不到内嵌运行时归档（${archivePath}）：${(err as Error).message}`)
  }
  if (!stat.isFile() || stat.size !== archiveSize) {
    throw new Error(`内嵌运行时归档大小不匹配（期望 ${archiveSize}，实际 ${stat.size}）`)
  }

  return {
    schemaVersion: 1,
    runtimeId,
    platform: 'linux',
    arch: 'x64',
    nodeVersion,
    pnpmVersion,
    dshVersion,
    archiveName,
    archiveSize,
    archiveSha256,
    archivePath,
  }
}
