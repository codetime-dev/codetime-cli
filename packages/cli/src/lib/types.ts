import type { spawn } from 'node:child_process'

export interface RunContext {
  env: NodeJS.ProcessEnv
  stdin: AsyncIterable<unknown> & { isTTY?: boolean }
  stdout: NodeJS.WriteStream | WritableLike
  stderr: NodeJS.WriteStream | WritableLike
  fetch: typeof fetch
  spawn: typeof spawn
}

export interface WritableLike {
  write: (text: string) => void
}

export type ParsedArgs = Record<string, unknown> & { _: string[] }

export interface BackfillImportCounts {
  inserted: number
  skipped: number
  conflicts: number
  failed: number
}

export interface BackfillSourceFile {
  path: string
  modifiedAt: string
}

export interface BackfillIncrementalState {
  version: 1
  sources: Partial<Record<
    import('@codetime/shared').BackfillSourceId,
    { watermarkTs: string }
  >>
}

export interface SyncLocalTriggerState {
  version: 1
  lastTriggeredAt?: string
  lastStartedAt?: string
  lastCompletedAt?: string
  lastExitCode?: number
  pid?: number
}

export interface SyncLocalLock {
  pid: number
  startedAt: string
}
