import type { CanonicalEvent } from '@codetime/shared'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { createCodexAdapter } from '../src/adapters/codex.ts'

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
  assert.equal(usages[2].metrics?.tokensOutput, 4)
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
