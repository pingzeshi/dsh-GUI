import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { create, extract, list } from 'tar'

const FIXED_MTIME = new Date('2020-01-01T00:00:00.000Z')

function fail(message) {
  console.error(message)
  process.exit(2)
}

function safeArchivePath(value) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false
  return !normalized.split('/').some((part) => part === '..' || part === '')
}

async function collectEntries(root) {
  const entries = []
  async function walk(relativeDirectory) {
    const absoluteDirectory = relativeDirectory
      ? path.join(root, ...relativeDirectory.split('/'))
      : root
    const children = await fs.readdir(absoluteDirectory, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name
      if (!safeArchivePath(relativePath)) fail(`归档中出现不安全路径：${relativePath}`)
      if (child.isSymbolicLink()) fail(`Windows 运行时不得包含符号链接：${relativePath}`)
      if (!child.isDirectory() && !child.isFile()) {
        fail(`Windows 运行时包含不支持的文件类型：${relativePath}`)
      }
      entries.push(relativePath)
      if (child.isDirectory()) await walk(relativePath)
    }
  }
  await walk('')
  return entries
}

async function validateArchive(archivePath) {
  let count = 0
  await list({
    file: archivePath,
    strict: true,
    onentry(entry) {
      count += 1
      if (!safeArchivePath(entry.path)) {
        entry.resume()
        throw new Error(`归档中出现不安全路径：${entry.path}`)
      }
      entry.resume()
    },
  })
  if (count === 0) throw new Error('运行时归档为空')
}

async function createArchive(sourceDirectory, archivePath) {
  const entries = await collectEntries(sourceDirectory)
  if (entries.length === 0) fail('运行时目录为空')
  // tar 把以 @ 开头的条目解释为“拼接另一个归档”；统一添加 ./ 可保留 scoped npm 包名。
  const archiveEntries = entries.map((entry) => `./${entry}`)
  create(
    {
      cwd: sourceDirectory,
      file: archivePath,
      gzip: { level: 9, mtime: 0 },
      mtime: FIXED_MTIME,
      noDirRecurse: true,
      portable: true,
      strict: true,
      sync: true,
    },
    archiveEntries,
  )
  await validateArchive(archivePath)
}

async function extractArchive(archivePath, destinationDirectory) {
  await validateArchive(archivePath)
  await extract({
    cwd: destinationDirectory,
    file: archivePath,
    preservePaths: false,
    strict: true,
  })
}

const [operation, firstPath, secondPath] = process.argv.slice(2)
if (!firstPath || !secondPath || !['create', 'extract'].includes(operation)) {
  fail('用法：node runtime-archive.mjs <create|extract> <源路径> <目标路径>')
}

if (operation === 'create') {
  await createArchive(path.resolve(firstPath), path.resolve(secondPath))
} else {
  await extractArchive(path.resolve(firstPath), path.resolve(secondPath))
}
