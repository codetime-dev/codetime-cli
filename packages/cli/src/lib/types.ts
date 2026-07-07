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

// Bump `BACKFILL_STATE_SCHEMA_VERSION` whenever the offline parsers
// change in a way that invalidates already-uploaded rollups (e.g. the
// Claude assistant-message dedup added in v2, the Codex fast/priority
// model-name rewrite added in v3, the v4 fix that stops inferring
// Codex fast/priority from CODEX_HOME/config.toml, and the v5 batch of
// ccusage-parity token fixes — OpenCode step-finish double-count, Amp
// tokens.total / ledger-less fallback, Codex cumulative-only token_count,
// and the pi/gemini edge cases). The CLI compares the constant against
// the on-disk schema; on a mismatch it drops every watermark so the next
// sync silently re-parses all jsonl from scratch and upserts the rebuilt
// rollups (`replace: true` is already set) — no purge, nothing deleted.
// Users get the fix transparently the next time their agent runs.
export const BACKFILL_STATE_SCHEMA_VERSION = 5

export interface BackfillIncrementalState {
  version: typeof BACKFILL_STATE_SCHEMA_VERSION
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
