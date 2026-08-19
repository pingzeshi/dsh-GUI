#!/usr/bin/env node

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

const ZSTD_MAGIC = 4247762216
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const apply = process.argv.includes('--apply')
const dshHomeArg = process.argv.find((arg) => arg.startsWith('--dsh-home='))
const dshHome = path.resolve(dshHomeArg?.slice('--dsh-home='.length) || process.env.DSH_HOME || path.join(homedir(), '.dsh'))
const sessionsRoot = path.join(dshHome, 'sessions')
const storageNames = ['workspace.json', 'session_projcache.json']

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function windowsPathToWsl(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!match) return null
  const drive = match[1].toLowerCase()
  const rest = match[2].replace(/[\\/]+/g, '/')
  return `/mnt/${drive}/${rest}`.replace(/\/$/, '')
}

function projectKey(cwd) {
  if (!cwd) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function encodeSegment(raw) {
  if (!raw) throw new Error('cannot encode an empty session id')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function zstdFrameEnd(buffer, start = 0) {
  let offset = start
  if (buffer.length - start < 5 || buffer.readUInt32LE(start) !== ZSTD_MAGIC) {
    throw new Error('invalid Zstandard header frame magic')
  }
  offset += 4
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  if ((descriptor & 24) !== 0) throw new Error('reserved Zstandard frame-header bit')
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buffer.length - offset < remainingHeaderBytes) throw new Error('truncated Zstandard frame header')
  offset += remainingHeaderBytes
  for (;;) {
    if (buffer.length - offset < 3) throw new Error('truncated Zstandard block header')
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    if (blockType === 3) throw new Error('reserved Zstandard block type')
    const payloadBytes = blockType === 1 ? 1 : blockSize
    if (buffer.length - offset < payloadBytes) throw new Error('truncated Zstandard block')
    offset += payloadBytes
    if (lastBlock) break
  }
  if (checksum) {
    if (buffer.length - offset < 4) throw new Error('truncated Zstandard checksum')
    offset += 4
  }
  return offset
}

function validateJsonLines(buffer, label) {
  if (buffer.length === 0) return 0
  if (buffer.at(-1) !== 10) throw new Error(`${label} does not end at a JSONL record boundary`)
  const lines = buffer.toString('utf8').split('\n')
  lines.pop()
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) throw new Error(`${label} contains an empty JSONL record at line ${index + 1}`)
    try {
      JSON.parse(lines[index])
    } catch (error) {
      throw new Error(`${label} contains invalid JSON at line ${index + 1}: ${error.message}`)
    }
  }
  return lines.length
}

function decodeArtifact(buffer, compression) {
  if (compression === 'zstd') {
    const headerEnd = zstdFrameEnd(buffer)
    const plaintext = zstdDecompressSync(buffer.subarray(0, headerEnd))
    if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1) {
      throw new Error('first Zstandard frame is not exactly one JSONL header line')
    }
    const eventChunks = []
    let eventFrameCount = 0
    for (let offset = headerEnd; offset < buffer.length;) {
      const end = zstdFrameEnd(buffer, offset)
      eventChunks.push(zstdDecompressSync(buffer.subarray(offset, end)))
      eventFrameCount += 1
      offset = end
    }
    const eventCount = validateJsonLines(Buffer.concat(eventChunks), 'compressed session event stream')
    return {
      header: JSON.parse(plaintext.subarray(0, -1).toString('utf8')),
      tail: buffer.subarray(headerEnd),
      eventFrameCount,
      eventCount,
    }
  }
  const newline = buffer.indexOf(10)
  if (newline < 0) throw new Error('uncompressed session has no JSONL header line')
  const tail = buffer.subarray(newline + 1)
  return {
    header: JSON.parse(buffer.subarray(0, newline).toString('utf8')),
    tail,
    eventFrameCount: 0,
    eventCount: validateJsonLines(tail, 'uncompressed session event stream'),
  }
}

function encodeArtifact(header, tail, compression) {
  const headerLine = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')
  return compression === 'zstd'
    ? Buffer.concat([zstdCompressSync(headerLine, CHECKSUM_OPTIONS), tail])
    : Buffer.concat([headerLine, tail])
}

async function listArtifacts() {
  const artifacts = []
  for (const project of await fs.readdir(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(sessionsRoot, project.name)
    for (const session of await fs.readdir(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDir = path.join(projectDir, session.name)
      const entries = await fs.readdir(sessionDir)
      const zstd = entries.includes('session.jsonl.zstd')
      const plain = entries.includes('session.jsonl')
      if (zstd === plain) throw new Error(`expected exactly one session artifact in ${sessionDir}`)
      artifacts.push({
        projectName: project.name,
        sessionName: session.name,
        sessionDir,
        fileName: zstd ? 'session.jsonl.zstd' : 'session.jsonl',
        compression: zstd ? 'zstd' : 'none',
      })
    }
  }
  return artifacts
}

function transformKeys(value, keys, changes, pointer = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => transformKeys(item, keys, changes, `${pointer}/${index}`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    const next = `${pointer}/${key}`
    if (keys.has(key) && typeof item === 'string') {
      const mapped = windowsPathToWsl(item)
      if (mapped) {
        value[key] = mapped
        changes.push({ pointer: next, from: item, to: mapped })
      }
    } else {
      transformKeys(item, keys, changes, next)
    }
  }
}

async function prepareStorageTransforms(stagingRoot) {
  const result = []
  const stagedStorage = path.join(stagingRoot, 'storages')
  if (apply) await fs.mkdir(stagedStorage, { recursive: true, mode: 0o700 })
  for (const name of storageNames) {
    const source = path.join(dshHome, 'storages', name)
    const raw = await fs.readFile(source, 'utf8')
    const data = JSON.parse(raw)
    const changes = []
    transformKeys(data, new Set(name === 'workspace.json' ? ['path'] : ['cwd']), changes)
    const encoded = `${JSON.stringify(data, null, 2)}\n`
    const staged = path.join(stagedStorage, name)
    if (apply) await fs.writeFile(staged, encoded, { flag: 'wx', mode: 0o600 })
    result.push({ name, source, staged, changes, encoded })
  }
  return result
}

async function validateAndMaybeStageSessions(stagingSessions) {
  const artifacts = await listArtifacts()
  const plans = []
  const targets = new Set()
  for (const artifact of artifacts) {
    const sourceFile = path.join(artifact.sessionDir, artifact.fileName)
    const sourceBuffer = await fs.readFile(sourceFile)
    const decoded = decodeArtifact(sourceBuffer, artifact.compression)
    const { header } = decoded
    if (typeof header.id !== 'string' || typeof header.cwd !== 'string') {
      throw new Error(`session header lacks id/cwd: ${sourceFile}`)
    }
    if (artifact.sessionName !== encodeSegment(header.id)) {
      throw new Error(`session directory does not match header id: ${sourceFile}`)
    }
    if (artifact.projectName !== projectKey(header.cwd)) {
      throw new Error(`project directory does not match header cwd: ${sourceFile}`)
    }
    const mappedCwd = windowsPathToWsl(header.cwd)
    const targetProject = mappedCwd ? projectKey(mappedCwd) : artifact.projectName
    const targetKey = `${targetProject}/${artifact.sessionName}`
    if (targets.has(targetKey)) throw new Error(`duplicate target session: ${targetKey}`)
    targets.add(targetKey)
    const targetDir = path.join(stagingSessions, targetProject, artifact.sessionName)
    const targetFile = path.join(targetDir, artifact.fileName)
    const newHeader = mappedCwd ? { ...header, cwd: mappedCwd } : header
    plans.push({
      ...artifact,
      sourceFile,
      targetDir,
      targetFile,
      oldCwd: header.cwd,
      newCwd: newHeader.cwd,
      mapped: Boolean(mappedCwd),
      tailSha256: sha256(decoded.tail),
      eventFrameCount: decoded.eventFrameCount,
      eventCount: decoded.eventCount,
    })
    if (!apply) continue
    await fs.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 })
    await fs.cp(artifact.sessionDir, targetDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    })
    const transformed = encodeArtifact(newHeader, decoded.tail, artifact.compression)
    const tempFile = `${targetFile}.path-migration.tmp`
    const handle = await fs.open(tempFile, 'wx', 0o600)
    try {
      await handle.writeFile(transformed)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tempFile, targetFile)
    const stagedDecoded = decodeArtifact(await fs.readFile(targetFile), artifact.compression)
    if (stagedDecoded.header.id !== header.id || stagedDecoded.header.cwd !== newHeader.cwd) {
      throw new Error(`staged header verification failed: ${targetFile}`)
    }
    if (sha256(stagedDecoded.tail) !== sha256(decoded.tail)) {
      throw new Error(`event frames changed while staging: ${targetFile}`)
    }
    if (path.basename(path.dirname(path.dirname(targetFile))) !== projectKey(stagedDecoded.header.cwd)) {
      throw new Error(`staged project directory mismatch: ${targetFile}`)
    }
  }
  return plans
}

async function commit(stagingRoot, stagingSessions, storagePlans, sessionPlans) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
  const backupRoot = path.join(path.dirname(dshHome), `.dsh-path-backup-${stamp}`)
  const backupStorages = path.join(backupRoot, 'storages')
  await fs.mkdir(backupStorages, { recursive: true, mode: 0o700 })

  const oldSessions = path.join(backupRoot, 'sessions')
  await fs.rename(sessionsRoot, oldSessions)
  try {
    await fs.rename(stagingSessions, sessionsRoot)
  } catch (error) {
    await fs.rename(oldSessions, sessionsRoot)
    throw error
  }

  const replaced = []
  try {
    for (const plan of storagePlans) {
      const backup = path.join(backupStorages, plan.name)
      await fs.rename(plan.source, backup)
      try {
        await fs.rename(plan.staged, plan.source)
      } catch (error) {
        await fs.rename(backup, plan.source)
        throw error
      }
      replaced.push({ ...plan, backup })
    }
  } catch (error) {
    for (const item of replaced.reverse()) {
      await fs.rename(item.source, item.staged)
      await fs.rename(item.backup, item.source)
    }
    await fs.rename(sessionsRoot, stagingSessions)
    await fs.rename(oldSessions, sessionsRoot)
    throw error
  }

  const report = {
    createdAt: new Date().toISOString(),
    dshHome,
    sessions: sessionPlans.length,
    mappedSessions: sessionPlans.filter((item) => item.mapped).length,
    storageChanges: Object.fromEntries(storagePlans.map((item) => [item.name, item.changes.length])),
    mappings: [...new Set(sessionPlans.map((item) => `${item.oldCwd} -> ${item.newCwd}`))],
    eventFramesPreserved: true,
    eventFramesValidated: sessionPlans.reduce((total, item) => total + item.eventFrameCount, 0),
    eventRecordsValidated: sessionPlans.reduce((total, item) => total + item.eventCount, 0),
  }
  await fs.writeFile(path.join(backupRoot, 'migration-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return { backupRoot, report, stagingRoot }
}

async function main() {
  const stagingRoot = apply
    ? await fs.mkdtemp(path.join(path.dirname(dshHome), '.dsh-path-staging-'))
    : path.join(path.dirname(dshHome), '.dry-run-only')
  const stagingSessions = path.join(stagingRoot, 'sessions')
  if (apply) await fs.mkdir(stagingSessions, { mode: 0o700 })

  const sessionPlans = await validateAndMaybeStageSessions(stagingSessions)
  const storagePlans = await prepareStorageTransforms(stagingRoot)
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    dshHome,
    sessions: sessionPlans.length,
    mappedSessions: sessionPlans.filter((item) => item.mapped).length,
    alreadyLinuxSessions: sessionPlans.filter((item) => !item.mapped && item.newCwd.startsWith('/')).length,
    workspaceChanges: storagePlans.find((item) => item.name === 'workspace.json')?.changes.length || 0,
    projectionCacheChanges: storagePlans.find((item) => item.name === 'session_projcache.json')?.changes.length || 0,
    mappings: [...new Set(sessionPlans.map((item) => `${item.oldCwd} -> ${item.newCwd}`))],
    eventFramesPreserved: true,
    eventFramesValidated: sessionPlans.reduce((total, item) => total + item.eventFrameCount, 0),
    eventRecordsValidated: sessionPlans.reduce((total, item) => total + item.eventCount, 0),
  }
  if (!apply) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  if (summary.sessions === 0 || summary.mappedSessions !== summary.sessions) {
    throw new Error(`refusing partial migration: ${summary.mappedSessions}/${summary.sessions} sessions map from Windows paths`)
  }
  if (summary.workspaceChanges === 0 || summary.projectionCacheChanges === 0) {
    throw new Error('refusing migration because workspace/projection path changes were not found')
  }
  const committed = await commit(stagingRoot, stagingSessions, storagePlans, sessionPlans)
  console.log(JSON.stringify({ ...summary, backupRoot: committed.backupRoot }, null, 2))
}

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})
