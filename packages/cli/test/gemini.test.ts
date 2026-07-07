import type { CanonicalEvent } from '@codetime/shared'
import type { RunContext } from '../src/lib/types.ts'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { createGeminiAdapter } from '../src/adapters/gemini.ts'
import { run } from '../src/cli.ts'

const adapter = createGeminiAdapter()

async function parse(filePath: string): Promise<CanonicalEvent[]> {
  return adapter.parseSessionFile!(filePath, { _: [] })
}

function usageEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  return events.filter(event => event.type === 'model.usage')
}

async function writeLines(filePath: string, records: unknown[]): Promise<void> {
  await writeFile(filePath, records.map(record => JSON.stringify(record)).join('\n'), 'utf8')
}

test('parses JSONL direct events and keeps tokensInput cache-inclusive', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-'))
  const file = path.join(dir, 'session.jsonl')
  await writeLines(file, [
    { sessionId: 's1', type: 'gemini', model: 'gemini-2.5-pro', id: 'm1', timestamp: '2026-04-29T00:00:01.000Z', tokens: { input: 100, output: 20, cached: 30 } },
    { type: 'gemini', model: 'gemini-2.5-pro', id: 'm2', timestamp: '2026-04-29T00:00:02.000Z', tokens: { input: 200, output: 40, cached: 0 } },
  ])

  const usages = usageEvents(await parse(file))
  assert.equal(usages.length, 2)

  // cached (30) is not folded into input here (no `total` proves overlap), so
  // codetime's cache-inclusive convention rebuilds tokensInput as 100 + 30.
  assert.equal(usages[0].metrics?.tokensInput, 130)
  assert.equal(usages[0].metrics?.tokensCacheReadInput, 30)
  assert.equal(usages[0].metrics?.tokensOutput, 20)
  assert.equal(usages[0].metrics?.tokensTotal, 150)
  assert.equal(usages[0].model, 'gemini-2.5-pro')

  assert.equal(usages[1].metrics?.tokensInput, 200)
  assert.equal(usages[1].metrics?.tokensCacheReadInput, undefined)
  assert.equal(usages[1].metrics?.tokensTotal, 240)
})

test('empty-string ids are not a dedup key; distinct events are kept', async () => {
  // stringField returns '' verbatim; treating it as a real id collapsed distinct
  // events (last-write-wins). ccusage non_empty_string maps '' -> None -> no dedup.
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-'))
  const file = path.join(dir, 'session.jsonl')
  await writeLines(file, [
    { type: 'gemini', model: 'g', id: '', timestamp: '2026-04-29T00:00:01.000Z', tokens: { input: 10, output: 5 } },
    { type: 'gemini', model: 'g', id: '  ', timestamp: '2026-04-29T00:00:02.000Z', tokens: { input: 999, output: 5 } },
  ])

  const usages = usageEvents(await parse(file))
  assert.equal(usages.length, 2)
  assert.equal(usages[0].metrics?.tokensInput, 10)
  assert.equal(usages[1].metrics?.tokensInput, 999)
})

test('brackets usage events with session.started and session.ended', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-'))
  const file = path.join(dir, 'session.jsonl')
  await writeLines(file, [
    { type: 'gemini', model: 'g', timestamp: '2026-04-29T00:00:01.000Z', tokens: { input: 10, output: 5 } },
  ])

  const events = await parse(file)
  assert.equal(events[0].type, 'session.started')
  assert.equal(events.at(-1)?.type, 'session.ended')
  assert.equal(usageEvents(events).length, 1)
})

test('dedupes JSONL direct events by id, last write wins', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-'))
  const file = path.join(dir, 'session.jsonl')
  await writeLines(file, [
    { type: 'gemini', model: 'g', id: 'dup', timestamp: '2026-04-29T00:00:01.000Z', tokens: { input: 10, output: 5 } },
    { type: 'gemini', model: 'g', id: 'dup', timestamp: '2026-04-29T00:00:02.000Z', tokens: { input: 999, output: 5 } },
  ])

  const usages = usageEvents(await parse(file))
  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 999)
})

test('parses JSON stats.models, peeling cache out of input', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-'))
  const file = path.join(dir, 'session.json')
  await writeFile(file, JSON.stringify({
    sessionId: 's-stats',
    timestamp: '2026-04-29T00:00:00.000Z',
    stats: {
      models: {
        'gemini-2.5-flash': { tokens: { prompt: 100, candidates: 20, cached: 40 } },
      },
    },
  }), 'utf8')

  const usages = usageEvents(await parse(file))
  assert.equal(usages.length, 1)
  assert.equal(usages[0].model, 'gemini-2.5-flash')
  // stats always count cache inside `prompt`; peeled out then rebuilt → 60 + 40.
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[0].metrics?.tokensCacheReadInput, 40)
  assert.equal(usages[0].metrics?.tokensOutput, 20)
  assert.equal(usages[0].metrics?.tokensTotal, 120)
})

test('drops records without a model and ignores malformed JSONL lines', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-'))
  const file = path.join(dir, 'session.jsonl')
  await writeFile(file, [
    '{ not valid json',
    JSON.stringify({ type: 'gemini', timestamp: '2026-04-29T00:00:01.000Z', tokens: { input: 10, output: 5 } }),
  ].join('\n'), 'utf8')

  assert.deepEqual(await parse(file), [])
})

test('backfill import wires gemini end to end into rollups', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const tmpDir = path.join(home, '.gemini', 'tmp', 'chats')
  await mkdir(tmpDir, { recursive: true })
  await writeLines(path.join(tmpDir, 'session.jsonl'), [
    { sessionId: 's1', type: 'gemini', model: 'gemini-2.5-pro', id: 'm1', timestamp: '2026-04-29T00:00:01.000Z', tokens: { input: 100, output: 20, cached: 30 } },
    { type: 'gemini', model: 'gemini-2.5-pro', id: 'm2', timestamp: '2026-04-29T00:00:02.000Z', tokens: { input: 200, output: 40, cached: 0 } },
  ])

  let capturedBody = ''
  const exitCode = await run(
    ['backfill', 'import', '--source', 'gemini', '--home', home, '--api-url', 'http://example.test'],
    {
      env: { HOME: home },
      stdin: Readable.from([]),
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      spawn: (() => ({ pid: 1, unref() {} })) as unknown as RunContext['spawn'],
      fetch: (async (_url: string, init?: { body?: unknown }) => {
        capturedBody = String(init?.body)
        const rollups = JSON.parse(capturedBody).rollups
        return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
      }) as unknown as RunContext['fetch'],
    },
  )

  assert.equal(exitCode, 0)
  const modelRollup = JSON.parse(capturedBody).rollups[0].modelRollups[0]
  assert.equal(modelRollup.callCount, 2)
  assert.equal(modelRollup.inputTokens, 130 + 200)
  assert.equal(modelRollup.outputTokens, 20 + 40)
  assert.equal(modelRollup.totalTokens, 150 + 240)
})

// ── ccusage parity ──
//
// These cases are lifted verbatim from ccusage's Rust gemini tests so the port
// stays faithful. ccusage reports `input_tokens` cache-exclusive; codetime's
// tokensInput is cache-inclusive, so the expected input here equals ccusage's
// input_tokens + cache_read_input_tokens.

test('parity: ccusage gemini/loader loads_jsonl_token_events_and_separates_cached_input', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-'))
  const file = path.join(dir, 'session-a.jsonl')
  await writeLines(file, [
    { sessionId: 'session-a', projectHash: 'project-a', startTime: '2026-05-17T11:07:00.000Z' },
    { id: 'msg-a', timestamp: '2026-05-17T11:07:32.000Z', type: 'gemini', model: 'gemini-3-flash-preview', tokens: { input: 15_327, output: 23, cached: 11_526, thoughts: 919, tool: 7, total: 16_276 } },
  ])

  const usages = usageEvents(await parse(file))
  assert.equal(usages.length, 1)
  assert.equal(usages[0].model, 'gemini-3-flash-preview')
  // ccusage: input_tokens=3808 (cache-exclusive) + cache_read=11526 → 15334.
  assert.equal(usages[0].metrics?.tokensInput, 3808 + 11_526)
  assert.equal(usages[0].metrics?.tokensCacheReadInput, 11_526)
  // ccusage's raw output (candidates)=23 excludes thoughts; codetime folds
  // thoughts (919) into billable tokensOutput → 23 + 919 = 942.
  assert.equal(usages[0].metrics?.tokensOutput, 23 + 919)
  assert.equal(usages[0].metrics?.tokensReasoningOutput, 919) // ccusage extra_total_tokens (informational subset)
  assert.equal(usages[0].metrics?.tokensTotal, 16_276)
})

test('parity: ccusage gemini/parser falls_back_to_total_tokens_when_parts_are_missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-'))
  const file = path.join(dir, 'session.jsonl')
  await writeLines(file, [
    { type: 'gemini', model: 'gemini-test', timestamp: '2026-05-17T00:00:00.000Z', tokens: { total: 654 } },
  ])

  const usages = usageEvents(await parse(file))
  assert.equal(usages.length, 1)
  // ccusage attributes the whole total to output when parts are absent.
  assert.equal(usages[0].metrics?.tokensOutput, 654)
  assert.equal(usages[0].metrics?.tokensReasoningOutput, undefined)
  assert.equal(usages[0].metrics?.tokensInput, undefined)
  assert.equal(usages[0].metrics?.tokensTotal, 654)
})
