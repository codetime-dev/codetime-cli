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
// and the pi/gemini edge cases, and the v6 Codex UUIDv7 creation-anchor
// that skips copied branch/goal rollout history, and the v7 realpath
// canonicalization of source file paths so symlinked agent homes stop
// producing duplicate rollup identities, and the v8 Codex model-name
// fixes — `session_meta.model_provider` is no longer stored as the model,
// the model is seeded from the first `turn_context`, `codex-auto-review`
// resolves to the review model shipping on that date, and a proxy's
// effort parenthetical is stripped, and the v9 Codex replay-dedup batch —
// a re-emitted `last_token_usage` is dropped when the cumulative
// `total_token_usage` did not advance, and a forked rollout's replayed
// history is matched against its parent's own usage stream instead of the
// same-second heuristic, which missed replays spanning several seconds and
// nested forks, and the v9 Claude advisor fix — `advisor_message` entries in
// `message.usage.iterations[]` are a different model's call that the enclosing
// usage does not carry, so their tokens were being dropped). The CLI compares the
// constant against the on-disk schema; on a mismatch it drops every
// watermark so the next sync silently re-parses all jsonl from scratch
// and upserts the rebuilt rollups (`replace: true` is already set) — no
// purge, nothing deleted. Users get the fix transparently the next time
// their agent runs.
export const BACKFILL_STATE_SCHEMA_VERSION = 9

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
