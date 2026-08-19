import * as fs from 'fs'
import * as path from 'path'
import { extract } from 'tar'

function safeArchivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return false
  }
  return !normalized.split('/').some((part) => part === '..' || part === '')
}

async function main(): Promise<void> {
  const [archivePath, destinationDirectory] = process.argv.slice(2)
  if (!archivePath || !destinationDirectory) {
    throw new Error('用法：extract-runtime <归档路径> <目标目录>')
  }
  if (!path.win32.isAbsolute(archivePath) || !path.win32.isAbsolute(destinationDirectory)) {
    throw new Error('归档路径和目标目录必须是 Windows 绝对路径')
  }
  const destinationStat = await fs.promises.stat(destinationDirectory)
  if (!destinationStat.isDirectory()) throw new Error('Windows 运行时解压目标不是目录')

  let entryCount = 0
  await extract({
    cwd: destinationDirectory,
    file: archivePath,
    filter(entryPath, entry) {
      if (!safeArchivePath(entryPath)) {
        throw new Error(`Windows 运行时归档包含不安全路径：${entryPath}`)
      }
      const supportedType = 'type' in entry
        ? entry.type === 'File' ||
          entry.type === 'Directory' ||
          (entry.type === 'Link' &&
            typeof entry.linkpath === 'string' &&
            safeArchivePath(entry.linkpath))
        : entry.isFile() || entry.isDirectory()
      if (!supportedType) {
        throw new Error(`Windows 运行时归档包含不支持的条目：${entryPath}`)
      }
      entryCount += 1
      return true
    },
    preservePaths: false,
    strict: true,
  })
  if (entryCount === 0) throw new Error('Windows 运行时归档为空')
  process.stdout.write(`EXTRACTED=${entryCount}\n`)
}

void main().catch((err: Error) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  process.exitCode = 1
})
