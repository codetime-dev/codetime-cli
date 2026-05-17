import { randomUUID } from 'node:crypto'
// Persistent CLI config: API base URL, machine token, and a stable machine
// id that the user can re-pair without losing history. The two pieces live
// in separate files so the (unauthenticated) machine-id can be created early,
// before login.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

export function writeConfig(config: CliConfig, home: string = homedir()): void {
  const dir = configDir(home)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
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
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim()
    if (value.length > 0) {
      return value
    }
  }
  const id = randomUUID()
  const dir = configDir(home)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(file, `${id}\n`, { mode: 0o600 })
  return id
}

export function defaultMachineName(): string {
  return hostname()
}
