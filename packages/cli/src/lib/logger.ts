// File logger for the CLI. Hooks and the background sync-local runner
// detach with stdio: 'ignore', so stderr is gone. Persist failures here
// so users can diagnose problems after the fact.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const MAX_BYTES = 1 * 1024 * 1024 // 1 MiB; rotate to .1 when exceeded

export function logDir(home: string = homedir()): string {
  return path.join(home, '.codetime', 'logs')
}

export function logPath(home: string = homedir(), name = 'cli.log'): string {
  return path.join(logDir(home), name)
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name }
  }
  return { value: String(error) }
}

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    const info = await stat(file)
    if (info.size > MAX_BYTES) {
      await rename(file, `${file}.1`).catch(() => {})
    }
  }
  catch { /* missing file is fine */ }
}

export interface LogEntry {
  scope: string
  message?: string
  error?: unknown
  meta?: Record<string, unknown>
  level?: 'info' | 'warn' | 'error'
}

export async function writeLog(entry: LogEntry, home: string = homedir(), fileName = 'cli.log'): Promise<void> {
  try {
    const dir = logDir(home)
    await mkdir(dir, { recursive: true })
    const file = logPath(home, fileName)
    await rotateIfNeeded(file)
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: entry.level || (entry.error ? 'error' : 'info'),
      scope: entry.scope,
      pid: process.pid,
    }
    if (entry.message) {
      record.message = entry.message
    }
    if (entry.meta) {
      Object.assign(record, entry.meta)
    }
    if (entry.error !== undefined) {
      record.error = serializeError(entry.error)
    }
    await appendFile(file, `${JSON.stringify(record)}\n`)
  }
  catch {
    // Never let logging crash the caller.
  }
}

export async function logError(scope: string, error: unknown, meta: Record<string, unknown> = {}, home: string = homedir()): Promise<void> {
  await writeLog({ scope, error, meta, level: 'error' }, home)
}

export async function logInfo(scope: string, message: string, meta: Record<string, unknown> = {}, home: string = homedir()): Promise<void> {
  await writeLog({ scope, message, meta, level: 'info' }, home)
}
