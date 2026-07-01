import { randomUUID } from 'node:crypto'
// Persistent CLI config: API base URL, machine token, and a stable machine
// id that the user can re-pair without losing history. The two pieces live
// in separate files so the (unauthenticated) machine-id can be created early,
// before login.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import path from 'node:path'

export interface CliConfig {
  /** API base URL, e.g. http://localhost:4319. */
  remoteUrl?: string
  /** Better Auth apiKey. Send as `Authorization: Bearer <token>`. */
  token?: string
  /** Server-issued machine id. Independent of the local machine-id file. */
  machineId?: string
  /** User-visible identifier (defaults to os.hostname()). */
  machineName?: string
  /** User id this machine is bound to (mirrors token). */
  userId?: string
}

export function configDir(home: string = homedir()): string {
  return path.join(home, '.codetime')
}

export function configPath(home: string = homedir()): string {
  return path.join(configDir(home), 'config.json')
}

export function machineIdPath(home: string = homedir()): string {
  return path.join(configDir(home), 'machine-id')
}

export function readConfig(home: string = homedir()): CliConfig {
  const file = configPath(home)
  if (!existsSync(file)) {
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CliConfig
    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    return {}
  }
}

let atomicTmpCounter = 0

/**
 * Sync sibling of writeFileAtomic (see lib/fs.ts): write a same-dir temp then
 * rename over the target, so config is never left torn by a racing writer.
 * Last-writer-wins, which is correct for config.json. No fsync — tear-freedom
 * comes from rename, and this is a reconstructable local file.
 */
function writeFileAtomicSync(filePath: string, data: string, mode: number): void {
  const dir = path.dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${(atomicTmpCounter++).toString(36)}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', mode) // 'wx' = O_EXCL: a temp collision is a loud EEXIST, never a clobber
    writeSync(fd, data)
    closeSync(fd)
    fd = undefined
    chmodSync(tmp, mode) // force exact owner bits regardless of umask
    renameSyncWithRetry(tmp, filePath) // atomic replace; no fsync (see writeFileAtomic rationale)
  }
  catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      }
      catch { /* best-effort cleanup */ }
    }
    try {
      unlinkSync(tmp)
    }
    catch { /* best-effort cleanup */ }
    throw error
  }
}

function renameSyncWithRetry(from: string, to: string, attempts = 5): void {
  // Sync mirror of renameWithRetry (lib/fs.ts): on Windows MoveFileExW transiently
  // fails EPERM/EACCES/EBUSY when another handle lacks FILE_SHARE_DELETE, and Node
  // never retries. Without this, replacing config.json on login/token writes could
  // spuriously fail on Windows. Bounded synchronous backoff (~100ms total across 4
  // retries), then rethrow. On POSIX the first attempt always succeeds.
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to)
      return
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (i >= attempts - 1 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error
      }
      // Synchronous sleep: block this thread for the backoff without spinning.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (i + 1))
    }
  }
}

export function writeConfig(config: CliConfig, home: string = homedir()): void {
  writeFileAtomicSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, 0o600)
}

export function clearConfig(home: string = homedir()): void {
  const file = configPath(home)
  if (existsSync(file)) {
    rmSync(file)
  }
}

/** Read the persisted local machine id, generating one on first use. */
export function ensureLocalMachineId(home: string = homedir()): string {
  const file = machineIdPath(home)
  const existing = readMachineId(file)
  if (existing) {
    return existing
  }
  mkdirSync(configDir(home), { recursive: true })
  const id = randomUUID()
  try {
    // O_EXCL on the TARGET => exactly one creator wins across concurrent fresh
    // installs. A same-dir temp+rename would give each racer its own uuid
    // (unique temp names never collide), so the id must be the exclusive file.
    const fd = openSync(file, 'wx', 0o600)
    try {
      writeSync(fd, `${id}\n`)
    }
    finally {
      closeSync(fd)
    }
    return id
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    // The file already exists. Adopt a peer's real id if present. If it is
    // empty/whitespace/corrupt (a legacy or interrupted write — the O_EXCL
    // create leaves a 0-byte file for an instant before writeSync), heal it by
    // writing ours atomically so future reads are stable. The pre-O_EXCL code
    // overwrote such files; we must not regress to returning a fresh, never-
    // persisted id (identity churn) on every call.
    const peer = readMachineId(file)
    if (peer) {
      return peer
    }
    writeFileAtomicSync(file, `${id}\n`, 0o600)
    return id
  }
}

function readMachineId(file: string): string | null {
  if (!existsSync(file)) {
    return null
  }
  const value = readFileSync(file, 'utf8').trim()
  // Preserve legacy behavior: accept ANY non-empty value, never regenerate over
  // one — a machine's server association must survive a re-pair. A 0-byte file
  // (an interrupted create) reads as null and is healed by ensureLocalMachineId.
  return value.length > 0 ? value : null
}

export function defaultMachineName(): string {
  return hostname()
}
