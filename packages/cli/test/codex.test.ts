import type { CanonicalEvent } from '@codetime/shared'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { createCodexAdapter } from '../src/adapters/codex.ts'
import { buildSessionRollups } from '../src/backfill/rollup.ts'

const adapter = createCodexAdapter()

async function parseFile(fileName: string, records: unknown[]): Promise<CanonicalEvent[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-'))
  const file = path.join(dir, fileName)
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n'), 'utf8')
  return adapter.parseSessionFile!(file, { _: [] })
}

async function parse(records: unknown[]): Promise<CanonicalEvent[]> {
  return parseFile('session.jsonl', records)
}

// Build a UUIDv7 whose embedded 48-bit millisecond timestamp equals the given
// instant, mirroring real Codex rollout ids. Verified against real rollouts:
// the uuid ms always precedes the file's first own event by a few ms.
function uuidv7At(iso: string): string {
  const hex = Date.parse(iso).toString(16).padStart(12, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`
}

// Real Codex rollout filenames stamp LOCAL time in the readable part while event
// timestamps are UTC (e.g. JST names run 9h ahead). Deliberately use a +9h-style
// readable part so any implementation that parses it instead of the UUIDv7 fails.
function rolloutFileName(creationIso: string): string {
  return `rollout-2026-05-12T17-02-00-${uuidv7At(creationIso)}.jsonl`
}

function usageEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  return events.filter(event => event.type === 'model.usage')
}

function turnCompletedEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  return events.filter(event => event.type === 'turn.completed')
}

// Synthetic single-turn CanonicalEvent for rollup tests.
function turnEvent(sessionId: string, turnId: string, ts: string, type: CanonicalEvent['type']): CanonicalEvent {
  return {
    schemaVersion: '2026-04-29',
    ts,
    type,
    source: 'codex',
    agent: 'codex',
    sessionId,
    turnId,
    refs: { sourcePathHash: `sha256:${sessionId}` },
  }
}

// ── turn boundary timestamps (idle time must not inflate turn duration) ──

test('user_message closes the previous turn at that turn last event, not the new prompt', async () => {
  // Two turns with a 30-minute idle gap between turn 1's last activity and the
  // second prompt. The implicit close of turn 1 must carry turn 1's own last
  // event ts, so the idle gap is never folded into turn 1's duration.
  const events = await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 'session', cwd: '/w', model_provider: 'gpt-5' } },
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1' } },
    { timestamp: '2026-01-02T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'first prompt' } },
    { timestamp: '2026-01-02T00:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'reply one' } },
    // 30 minutes of idle, then a new turn_context + second prompt arrive.
    { timestamp: '2026-01-02T00:30:05.000Z', type: 'turn_context', payload: { turn_id: 'turn-2' } },
    { timestamp: '2026-01-02T00:30:05.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'second prompt' } },
    { timestamp: '2026-01-02T00:30:10.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'reply two' } },
  ])

  const turn1Id = events.find(event => event.type === 'prompt.submitted')!.turnId
  assert.equal(turn1Id, 'turn-1')
  const turn1Completed = turnCompletedEvents(events).filter(event => event.turnId === turn1Id)
  assert.equal(turn1Completed.length, 1)
  // turn.completed ts equals turn 1's last activity (the agent_message), NOT the
  // second prompt's ts.
  assert.equal(turn1Completed[0].ts, '2026-01-02T00:00:05.000Z')

  const rollup = buildSessionRollups(events)[0]
  const turn1Rollup = rollup.turnRollups!.find(turn => turn.turnId === turn1Id)!
  // 1s prompt→agent gap, no 30-minute idle leakage.
  assert.equal(turn1Rollup.durationMs, 4000)
  assert.ok(turn1Rollup.durationMs < 30 * 60 * 1000)
})

test('a turn closed by task_complete is not re-closed by the next user_message', async () => {
  // task_complete closes turn-1 explicitly; the following user_message must not
  // emit a second turn.completed for the same turnId.
  const events = await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 'session', cwd: '/w', model_provider: 'gpt-5' } },
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1' } },
    { timestamp: '2026-01-02T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'first prompt' } },
    { timestamp: '2026-01-02T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 4000 } },
    { timestamp: '2026-01-02T00:10:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'second prompt' } },
  ])

  const turn1Id = events.find(event => event.type === 'prompt.submitted')!.turnId
  const turn1Completed = turnCompletedEvents(events).filter(event => event.turnId === turn1Id)
  assert.equal(turn1Completed.length, 1)
  assert.equal(turn1Completed[0].confidence, 'exact') // the task_complete one
})

// ── rollup gap-clamped turn duration ──

test('turn duration sums gap-clamped active intervals', () => {
  // Four events in one turn at offsets 0, +1min, +21min (20-min gap), +23min
  // (2-min gap). Raw span is 23min but the 20-min gap is clamped to 5min, so the
  // active duration is 1 + 5 + 2 = 8 minutes.
  const events: CanonicalEvent[] = [
    turnEvent('gap-session', 'gap-turn', '2026-01-02T00:00:00.000Z', 'prompt.submitted'),
    turnEvent('gap-session', 'gap-turn', '2026-01-02T00:01:00.000Z', 'agent.operation'),
    turnEvent('gap-session', 'gap-turn', '2026-01-02T00:21:00.000Z', 'agent.operation'),
    turnEvent('gap-session', 'gap-turn', '2026-01-02T00:23:00.000Z', 'turn.completed'),
  ]

  const rollup = buildSessionRollups(events)[0]
  const turn = rollup.turnRollups!.find(t => t.turnId === 'gap-turn')!
  assert.equal(turn.durationMs, (1 + 5 + 2) * 60 * 1000)
  // Real timestamps are preserved even though duration is clamped.
  assert.equal(turn.startedAt, '2026-01-02T00:00:00.000Z')
  assert.equal(turn.lastEventAt, '2026-01-02T00:23:00.000Z')
})

test('session rollups carry the v3 schemaVersion', () => {
  const rollup = buildSessionRollups([
    turnEvent('schema-session', 'schema-turn', '2026-01-02T00:00:00.000Z', 'prompt.submitted'),
    turnEvent('schema-session', 'schema-turn', '2026-01-02T00:00:01.000Z', 'turn.completed'),
  ])[0]
  assert.equal(rollup.schemaVersion, 3)
})

// Synthetic model.usage event with a metric bag (v3 modelBuckets / TTL split).
function modelUsageEvent(
  ts: string,
  model: string,
  metrics: NonNullable<CanonicalEvent['metrics']>,
): CanonicalEvent {
  return {
    schemaVersion: '2026-04-29',
    ts,
    type: 'model.usage',
    source: 'claude-code',
    agent: 'claude-code',
    sessionId: 'bucket-session',
    model,
    metrics,
    refs: { sourcePathHash: 'sha256:bucket-session' },
  }
}

test('rollup builds modelBuckets grouped by 15-min bucket and model, with TTL split', () => {
  // Two models across two 15-min buckets (00:00 and 00:15), with a repeated
  // (bucket, model) pair to exercise summing.
  const rollup = buildSessionRollups([
    modelUsageEvent('2026-01-02T00:01:00.000Z', 'model-a', {
      tokensInput: 10,
      tokensCachedInput: 7,
      tokensCacheCreationInput: 300,
      tokensCacheCreation5mInput: 100,
      tokensCacheCreation1hInput: 200,
      tokensCacheReadInput: 5,
      tokensOutput: 4,
      tokensReasoningOutput: 1,
      tokensTotal: 21,
    }),
    modelUsageEvent('2026-01-02T00:14:00.000Z', 'model-a', {
      tokensInput: 5,
      tokensCacheCreationInput: 50,
      tokensCacheCreation5mInput: 50,
      tokensCacheCreation1hInput: 0,
      tokensOutput: 2,
      tokensTotal: 7,
    }),
    modelUsageEvent('2026-01-02T00:20:00.000Z', 'model-b', {
      tokensInput: 8,
      tokensOutput: 3,
      tokensTotal: 11,
    }),
  ])[0]

  // Sorted ts ascending, then model lexicographically.
  const buckets = rollup.modelBuckets!
  assert.equal(buckets.length, 2)
  assert.deepEqual(buckets.map(b => [b.ts, b.model]), [
    ['2026-01-02T00:00:00.000Z', 'model-a'],
    ['2026-01-02T00:15:00.000Z', 'model-b'],
  ])

  // First bucket merges both 00:00-window model-a events.
  const [a, b] = buckets
  assert.equal(a.callCount, 2)
  assert.equal(a.inputTokens, 15)
  assert.equal(a.cacheCreationInputTokens, 350)
  assert.equal(a.cacheCreation5mInputTokens, 150)
  assert.equal(a.cacheCreation1hInputTokens, 200)
  assert.equal(a.cacheReadInputTokens, 5)
  assert.equal(a.outputTokens, 6)
  assert.equal(a.reasoningOutputTokens, 1)
  assert.equal(a.totalTokens, 28)

  // Second bucket is the single model-b event with no TTL split reported.
  assert.equal(b.callCount, 1)
  assert.equal(b.inputTokens, 8)
  assert.equal(b.cacheCreation5mInputTokens, 0)
  assert.equal(b.cacheCreation1hInputTokens, 0)
  assert.equal(b.totalTokens, 11)

  // modelRollups accumulate the TTL split across buckets.
  const modelA = rollup.modelRollups.find(m => m.model === 'model-a')!
  assert.equal(modelA.cacheCreationInputTokens, 350)
  assert.equal(modelA.cacheCreation5mInputTokens, 150)
  assert.equal(modelA.cacheCreation1hInputTokens, 200)
  const modelB = rollup.modelRollups.find(m => m.model === 'model-b')!
  assert.equal(modelB.cacheCreation5mInputTokens, 0)
  assert.equal(modelB.cacheCreation1hInputTokens, 0)
})

// ── ccusage parity ──
//
// Token values come from ccusage's Rust codex tests (adapter/codex/mod.rs).
// codetime parses `event_msg → token_count → info.last_token_usage`; ccusage's
// `last_token_usage` cases use the same per-turn values, so token counts line
// up directly. (ccusage's `total_token_usage` accumulate-and-diff and headless
// `turn.completed`/`result` cases are NOT covered — codetime doesn't parse
// those formats; see the report accompanying these tests.)

test('parity: ccusage codex last_token_usage maps straight through', async () => {
  // From ccusage adapter/codex/mod.rs loads_directory_groups_… (first row).
  const events = await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 'session', cwd: '/w', model_provider: 'gpt-5' } },
    { timestamp: '2026-01-02T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5', last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 150 } } } },
  ])

  const usages = usageEvents(events)
  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[0].metrics?.tokensCachedInput, 10)
  assert.equal(usages[0].metrics?.tokensOutput, 50)
  assert.equal(usages[0].metrics?.tokensReasoningOutput, 0)
  assert.equal(usages[0].metrics?.tokensTotal, 150)
})

test('parity: ccusage codex reports_non_cached_input_separately (codetime keeps it inclusive)', async () => {
  // From ccusage adapter/codex/mod.rs reports_non_cached_codex_input_separately.
  // ccusage's daily report shows inputTokens=10 (100 − 90 cached); codetime
  // stores the raw cache-inclusive input (100) plus cached (90) and leaves the
  // non-cached split to the dashboard. Both agree on the underlying counts.
  const events = await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-1', cwd: '/w', model_provider: 'gpt-5' } },
    { timestamp: '2026-01-02T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5', last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 105 } } } },
  ])

  const usages = usageEvents(events)
  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 100) // ccusage report: non-cached = 100 − 90 = 10
  assert.equal(usages[0].metrics?.tokensCachedInput, 90)
  assert.equal(usages[0].metrics?.tokensOutput, 5)
  assert.equal(usages[0].metrics?.tokensTotal, 105)
})

test('parity: ccusage codex derives per-turn deltas from cumulative total_token_usage', async () => {
  // token_count events carrying ONLY info.total_token_usage (no last_token_usage) —
  // a real Codex shape. ccusage subtract_codex_raw_usage emits per-turn deltas
  // against a running baseline; codetime must not drop them.
  const usages = usageEvents(await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 's', cwd: '/w', model_provider: 'gpt-5' } },
    { timestamp: '2026-01-02T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } } },
    { timestamp: '2026-01-02T00:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, output_tokens: 130, total_tokens: 430 } } } },
  ]))

  assert.equal(usages.length, 2)
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[0].metrics?.tokensOutput, 50)
  // second turn's delta: 300-100 input, 130-50 output.
  assert.equal(usages[1].metrics?.tokensInput, 200)
  assert.equal(usages[1].metrics?.tokensOutput, 80)
})

test('parity: ccusage codex clamps cached_input_tokens to input_tokens', async () => {
  // cached must never exceed input, else the server's non-cached (input - cached)
  // goes negative. ccusage clamps cached.min(input).
  const usages = usageEvents(await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 's', cwd: '/w', model_provider: 'gpt-5' } },
    { timestamp: '2026-01-02T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 150, output_tokens: 50, total_tokens: 150 } } } },
  ]))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[0].metrics?.tokensCachedInput, 100) // clamped from 150
})

test('parity: ccusage codex dedupes consecutive identical last_token_usage', async () => {
  // From ccusage adapter/codex/loader.rs dedupes_matching_codex_usage_events.
  const events = await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-a', cwd: '/w', model_provider: 'gpt-5' } },
    { timestamp: '2026-01-02T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5', last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, total_tokens: 160 } } } },
    { timestamp: '2026-01-02T00:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5', last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, total_tokens: 160 } } } },
  ])

  assert.equal(usageEvents(events).length, 1)
})

// ── headless `codex exec` parity (turn.completed / result / bare data.usage) ──

test('parity: ccusage codex loads_saved_codex_exec_json_usage', async () => {
  // ccusage adapter/codex/loader.rs loads_saved_codex_exec_json_usage.
  const usages = usageEvents(await parse([
    { type: 'turn.completed', timestamp: '2026-01-02T03:04:05.000Z', model: 'gpt-5.2-codex', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, total_tokens: 150 } },
    { type: 'result', data: { timestamp: '2026-01-02T03:05:05.000Z', model_name: 'gpt-5.2-codex', usage: { prompt_tokens: 50, cached_tokens: 5, completion_tokens: 12 } } },
    { type: 'turn.completed', timestamp: '2026-01-02T03:06:05.000Z', model: 'gpt-5.2-codex', usage: { input_tokens: 9, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 0 } },
  ]))

  assert.equal(usages.length, 3)

  assert.equal(usages[0].metrics?.tokensInput, 120)
  assert.equal(usages[0].metrics?.tokensCachedInput, 20)
  assert.equal(usages[0].metrics?.tokensOutput, 30)
  assert.equal(usages[0].metrics?.tokensTotal, 150)
  assert.equal(usages[0].model, 'gpt-5.2-codex')

  // result line: prompt_tokens/cached_tokens/completion_tokens aliases;
  // total recomputed = 50 + 12 + 0 (cache not added).
  assert.equal(usages[1].metrics?.tokensInput, 50)
  assert.equal(usages[1].metrics?.tokensCachedInput, 5)
  assert.equal(usages[1].metrics?.tokensOutput, 12)
  assert.equal(usages[1].metrics?.tokensTotal, 62)
  assert.equal(usages[1].model, 'gpt-5.2-codex') // from data.model_name

  // total_tokens=0 is ignored; recomputed = 9 + 4 + 1.
  assert.equal(usages[2].metrics?.tokensInput, 9)
  // ccusage's raw output_tokens=4 excludes reasoning; codetime folds reasoning
  // into billable tokensOutput → 4 + 1 = 5. tokensReasoningOutput keeps the raw 1.
  assert.equal(usages[2].metrics?.tokensOutput, 5)
  assert.equal(usages[2].metrics?.tokensReasoningOutput, 1)
  assert.equal(usages[2].metrics?.tokensTotal, 14)
})

test('parity: ccusage codex headless tolerates non-string model/timestamp', async () => {
  // ccusage adapter/codex/loader.rs loads_headless_usage_with_unexpected_noncritical_field_types.
  const usages = usageEvents(await parse([
    { type: 'turn.completed', timestamp: false, model: { name: 'unexpected' }, usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, total_tokens: 150 } },
  ]))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].model, 'gpt-5') // object model ignored → fallback
  assert.equal(usages[0].metrics?.tokensInput, 120)
  assert.equal(usages[0].metrics?.tokensCachedInput, 20)
  assert.equal(usages[0].metrics?.tokensOutput, 30)
  assert.equal(usages[0].metrics?.tokensTotal, 150)
})

test('parity: ccusage codex headless ignores unrelated content text', async () => {
  // ccusage adapter/codex/loader.rs loads_headless_usage_with_token_count_text_content.
  const usages = usageEvents(await parse([
    { type: 'turn.completed', timestamp: '2026-01-02T03:04:05.000Z', model: 'gpt-5.2-codex', content: 'debug token_count payload text', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, total_tokens: 150 } },
  ]))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].model, 'gpt-5.2-codex')
  assert.equal(usages[0].metrics?.tokensInput, 120)
  assert.equal(usages[0].metrics?.tokensTotal, 150)
})

test('parity: ccusage codex uses nested model_name for standalone exec usage', async () => {
  // ccusage adapter/codex/loader.rs uses_nested_model_name_for_standalone_exec_usage.
  const usages = usageEvents(await parse([
    { data: { timestamp: '2026-03-01T00:00:00.000Z', model_name: 'gpt-5.2-codex', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ]))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].model, 'gpt-5.2-codex')
  assert.equal(usages[0].metrics?.tokensInput, 10)
  assert.equal(usages[0].metrics?.tokensOutput, 5)
  assert.equal(usages[0].metrics?.tokensTotal, 15)
})

// ── forked subagent replay (parent token history re-stamped at creation second) ──

test('parity: ccusage codex skips replayed parent token history in thread_spawn subagent files', async () => {
  // From ccusage loader.rs skips_replayed_parent_token_history_in_thread_spawn_subagent_files.
  // The subagent file opens with its own session_meta (thread_spawn), the parent's
  // session_meta, then the parent's token history replayed at the creation second
  // (08:03:00), then the subagent's own usage at later seconds. Only the latter counts.
  const usages = usageEvents(await parse([
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'session_meta', payload: { id: 'subagent-abc', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-xyz' } } } } },
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'session_meta', payload: { id: 'parent-xyz' } },
    // replayed parent history — all stamped at the subagent creation second
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200, total_tokens: 1200 }, total_token_usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200, total_tokens: 1200 } } } },
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 50, output_tokens: 100, total_tokens: 600 }, total_token_usage: { input_tokens: 1500, cached_input_tokens: 150, output_tokens: 300, total_tokens: 1800 } } } },
    // subagent's own entries — later seconds
    { timestamp: '2026-05-12T08:04:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5.2', last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 120 } } } },
    { timestamp: '2026-05-12T08:05:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 5, output_tokens: 10, total_tokens: 60 } } } },
  ]))

  assert.equal(usages.length, 2)
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[0].metrics?.tokensCachedInput, 10)
  assert.equal(usages[0].metrics?.tokensOutput, 20)
  assert.equal(usages[1].metrics?.tokensInput, 50)
  assert.equal(usages[1].metrics?.tokensOutput, 10)
})

test('parity: ccusage codex keeps_cumulative_baseline_when_skipping_subagent_replay', async () => {
  // The replayed parent block (total-only, all at the creation second) is skipped
  // BUT still advances the cumulative baseline, so the subagent's own first event
  // (total 1600) yields delta 100 (1600 - 1500), not 1600. Mirrors ccusage's test.
  const usages = usageEvents(await parse([
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'session_meta', payload: { id: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } },
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 } } } },
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, output_tokens: 300, total_tokens: 1800 } } } },
    { timestamp: '2026-05-12T08:04:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { model: 'gpt-5.2', total_token_usage: { input_tokens: 1600, output_tokens: 320, total_tokens: 1920 } } } },
  ]))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[0].metrics?.tokensOutput, 20)
})

test('a non-subagent file whose first two token_counts share a second is NOT skipped', async () => {
  // No thread_spawn marker → the same-second heuristic must not fire, so two
  // genuinely distinct turns that happen to land in the same wall-clock second
  // are both kept. Guards against over-eager replay skipping on normal sessions.
  const usages = usageEvents(await parse([
    { timestamp: '2026-05-12T08:03:00.100Z', type: 'session_meta', payload: { id: 'session', cwd: '/w', model_provider: 'gpt-5' } },
    { timestamp: '2026-05-12T08:03:00.200Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 130 } } } },
    { timestamp: '2026-05-12T08:03:00.900Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 20, output_tokens: 40, total_tokens: 260 } } } },
  ]))

  assert.equal(usages.length, 2)
})

test('a thread_spawn file whose first two token_counts differ in second is not skipped', async () => {
  // thread_spawn is present, but the first two usage-bearing token_counts fall in
  // DIFFERENT seconds → no re-stamped replay block, so nothing is skipped. Mirrors
  // ccusage detect_subagent_replay_second returning None when the seconds diverge.
  const usages = usageEvents(await parse([
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'session_meta', payload: { id: 'subagent-abc', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-xyz' } } } } },
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 130 } } } },
    { timestamp: '2026-05-12T08:04:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 5, output_tokens: 10, total_tokens: 60 } } } },
  ]))

  assert.equal(usages.length, 2)
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[1].metrics?.tokensInput, 50)
})

// ── copied branch/goal rollout history (verbatim copy, original timestamps) ──
//
// Codex branch/goal/resume forks copy the parent rollout's lines verbatim into a
// new file, keeping the ORIGINAL timestamps. The same-second replay heuristic
// above cannot catch those (nothing is re-stamped), and they escape the
// consecutive-identical dedupe too. The file's own events can only be stamped
// after its creation instant, which the filename's UUIDv7 carries in UTC — so any
// event_msg/response_item older than that instant is copied history. Mirrors the
// coverage of ccusage's cross-file dedupe (dedupes_copied_branch_history_across_
// session_files), but works on a single file, so incremental re-parses of the
// live branch file alone stay correct without the parent in memory.

test('parity: ccusage codex dedupes_copied_branch_history — pre-creation events are skipped via the UUIDv7 anchor', async () => {
  const creation = '2026-05-12T08:02:00.000Z'
  const events = await parseFile(rolloutFileName(creation), [
    // copied verbatim from the parent rollout — original (pre-creation) timestamps
    { timestamp: '2026-05-12T08:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.2' } },
    { timestamp: '2026-05-12T08:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200, reasoning_output_tokens: 20, total_tokens: 1200 } } } },
    // the branch's own usage — cumulative continues from the copied baseline
    { timestamp: '2026-05-12T08:02:30.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1600, cached_input_tokens: 300, output_tokens: 450, reasoning_output_tokens: 40, total_tokens: 2050 } } } },
  ])

  // Only the branch's own delta is counted, measured against the copied
  // baseline (1600-1000 etc.), matching ccusage's expected branch totals.
  const usages = usageEvents(events)
  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 600)
  assert.equal(usages[0].metrics?.tokensCachedInput, 200)
  assert.equal(usages[0].metrics?.tokensOutput, 250)
  assert.equal(usages[0].metrics?.tokensReasoningOutput, 20)
  assert.equal(usages[0].metrics?.tokensTotal, 850)
})

test('copied pre-creation activity events (prompts/tools) are dropped, not just token_counts', async () => {
  // The copied block contains the parent's prompts and tool calls too. Counting
  // them would double the parent's prompts, toolCalls, and active duration.
  const creation = '2026-05-12T08:02:00.000Z'
  const events = await parseFile(rolloutFileName(creation), [
    { timestamp: '2026-05-12T07:50:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'copied parent prompt' } },
    { timestamp: '2026-05-12T07:51:00.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'copied-call', arguments: '{"command":"ls"}' } },
    { timestamp: '2026-05-12T07:51:05.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'copied-call' } },
    // the branch's own activity
    { timestamp: '2026-05-12T08:02:10.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'own prompt' } },
    { timestamp: '2026-05-12T08:02:20.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 120 } } } },
  ])

  const prompts = events.filter(event => event.type === 'prompt.submitted')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].ts, '2026-05-12T08:02:10.000Z')
  assert.equal(events.filter(event => event.type === 'tool.started').length, 0)
  assert.equal(events.filter(event => event.type === 'tool.completed').length, 0)
  assert.equal(usageEvents(events).length, 1)
})

test('a normal rollout file keeps every event at or after its UUIDv7 creation instant', async () => {
  // Guard against over-eager dropping: events stamped exactly AT the creation
  // millisecond and later are the file's own and must all survive.
  const creation = '2026-05-12T08:02:00.000Z'
  const usages = usageEvents(await parseFile(rolloutFileName(creation), [
    { timestamp: creation, type: 'session_meta', payload: { id: 'session', cwd: '/w', model_provider: 'gpt-5' } },
    { timestamp: '2026-05-12T08:02:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 130 } } } },
    { timestamp: '2026-05-12T08:05:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 20, output_tokens: 40, total_tokens: 260 } } } },
  ]))

  assert.equal(usages.length, 2)
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[1].metrics?.tokensInput, 200)
})

test('files without a UUIDv7 rollout name never trigger the creation anchor', async () => {
  // Same copied-history shape as the parity test, but in a plain-named file
  // (headless logs, history.jsonl, tests): no anchor → nothing is dropped.
  const usages = usageEvents(await parse([
    { timestamp: '2026-05-12T08:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200, total_tokens: 1200 } } } },
    { timestamp: '2026-05-12T08:02:30.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1600, cached_input_tokens: 300, output_tokens: 450, total_tokens: 2050 } } } },
  ]))

  assert.equal(usages.length, 2)
  assert.equal(usages[0].metrics?.tokensInput, 1000)
  assert.equal(usages[1].metrics?.tokensInput, 600)
})

test('the same-second thread_spawn replay skip still works in a UUIDv7-named file', async () => {
  // Re-stamped replays are stamped AT the creation second — at or after the
  // uuid instant, so the anchor cannot catch them; the layer-1 same-second
  // heuristic must keep firing unchanged alongside the anchor.
  const creation = '2026-05-12T08:03:00.000Z'
  const usages = usageEvents(await parseFile(rolloutFileName(creation), [
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'session_meta', payload: { id: 'subagent-abc', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-xyz' } } } } },
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'session_meta', payload: { id: 'parent-xyz' } },
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200, total_tokens: 1200 } } } },
    { timestamp: '2026-05-12T08:03:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 50, output_tokens: 100, total_tokens: 600 } } } },
    { timestamp: '2026-05-12T08:04:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 120 } } } },
  ]))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 100)
})

// ── model naming ──
//
// The model that gets stored is the pricing key the backend looks up, so a
// wrong name is a silently-$0 (or silently-mispriced) row rather than a
// visible error.

// Token numbers are irrelevant to these tests — only the model stamped on
// the resulting usage event is.
function tokenCount(timestamp: string): unknown {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, total_tokens: 150 } } },
  }
}

test('session_meta.model_provider is never used as the model', async () => {
  // `model_provider` is the API provider id — `openai` for the real thing,
  // or whatever a third-party proxy calls itself. Reading it into `model`
  // is how `openai` / `crs` / `custom` used to reach the model leaderboard.
  const events = await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 'session', cwd: '/w', model_provider: 'openai' } },
    { timestamp: '2026-01-02T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    tokenCount('2026-01-02T00:00:02.000Z'),
  ])

  assert.equal(events.every(event => event.model !== 'openai'), true)
  assert.equal(usageEvents(events)[0].model, 'gpt-5.6-sol')
})

test('usage recorded before the first turn_context still carries the real model', async () => {
  // The model is seeded by scanning ahead for the first turn_context, so a
  // token_count that lands before it is not left model-less (or, previously,
  // stamped with the provider id).
  const events = await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 'session', cwd: '/w', model_provider: 'openai' } },
    tokenCount('2026-01-02T00:00:01.000Z'),
    { timestamp: '2026-01-02T00:00:02.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
  ])

  assert.equal(usageEvents(events)[0].model, 'gpt-5.6-sol')
  assert.equal(events.find(event => event.type === 'session.started')?.model, 'gpt-5.6-sol')
})

test('a rollout with no turn_context leaves the model unset rather than guessing', async () => {
  const events = await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'session_meta', payload: { id: 'session', cwd: '/w', model_provider: 'crs' } },
    tokenCount('2026-01-02T00:00:01.000Z'),
  ])

  assert.equal(usageEvents(events)[0].model, undefined)
})

test('the reasoning-effort parenthetical some proxies append is stripped', async () => {
  // `gpt-5.5(xhigh)` is not a catalogue id, and pricing does not vary by
  // effort — the effort is already carried by other fields.
  const usages = usageEvents(await parse([
    { timestamp: '2026-01-02T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.5(xhigh)' } },
    tokenCount('2026-01-02T00:00:01.000Z'),
  ]))

  assert.equal(usages[0].model, 'gpt-5.5')
})

test('parity: ccusage codex_log_model_fallback — codex-auto-review resolves by date', async () => {
  // Codex stamps `codex-auto-review` on its automatic review turns; the
  // tokens bill against whichever review model shipped on that date.
  // Mirrors ccusage's codex-auto-review-fallbacks.json snapshot.
  const cases: Array<[string, string]> = [
    ['2026-05-01T00:00:00.000Z', 'gpt-5.5'],
    ['2026-04-23T00:00:00.000Z', 'gpt-5.5'],
    ['2026-04-22T00:00:00.000Z', 'gpt-5.4'],
    ['2026-02-10T00:00:00.000Z', 'gpt-5.3-codex'],
    ['2025-09-20T00:00:00.000Z', 'gpt-5-codex'],
    ['2025-01-01T00:00:00.000Z', 'gpt-5'],
  ]
  for (const [ts, expected] of cases) {
    const usages = usageEvents(await parse([
      { timestamp: ts, type: 'turn_context', payload: { model: 'codex-auto-review' } },
      tokenCount(ts),
    ]))
    assert.equal(usages[0].model, expected, `${ts} → ${expected}`)
  }
})

test('the fast tier still suffixes the resolved model, not the raw label', async () => {
  const usages = usageEvents(await parse([
    { timestamp: '2026-05-01T00:00:00.000Z', type: 'turn_context', payload: { model: 'codex-auto-review', service_tier: 'priority' } },
    tokenCount('2026-05-01T00:00:01.000Z'),
  ]))

  assert.equal(usages[0].model, 'gpt-5.5-fast')
})
