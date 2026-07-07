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

async function parse(records: unknown[]): Promise<CanonicalEvent[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-'))
  const file = path.join(dir, 'session.jsonl')
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n'), 'utf8')
  return adapter.parseSessionFile!(file, { _: [] })
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
