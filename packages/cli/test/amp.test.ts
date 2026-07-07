import type { CanonicalEvent } from '@codetime/shared'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { createAmpAdapter } from '../src/adapters/amp.ts'

const adapter = createAmpAdapter()

async function parse(thread: unknown): Promise<CanonicalEvent[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'amp-'))
  const file = path.join(dir, 'T-x.json')
  await writeFile(file, JSON.stringify(thread), 'utf8')
  return adapter.parseSessionFile!(file, { _: [] })
}

function usageEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  return events.filter(e => e.type === 'model.usage')
}

test('parity: ccusage amp falls_back_to_total_tokens_when_amp_parts_are_missing', async () => {
  // A ledger event carrying only tokens.total (no input/output) must still be
  // counted, with the total folded into billable output. ccusage asserts
  // output_tokens == 345 (adapter/amp/parser.rs falls_back_to_total_tokens_...).
  const usages = usageEvents(await parse({
    id: 'T-x',
    usageLedger: {
      events: [
        { id: 'event-a', timestamp: '2026-01-02T00:00:00.000Z', model: 'gpt-5', tokens: { total: 345 } },
      ],
    },
  }))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensOutput, 345)
  assert.equal(usages[0].metrics?.tokensTotal, 345)
})

test('parity: ccusage amp ledger folds the shortfall of an explicit total into output', async () => {
  // {input:10, output:20, total:100} → ccusage counts 100 total (extra 70 folded
  // into billable output); the raw parts alone would be only 30.
  const usages = usageEvents(await parse({
    id: 'T-x',
    usageLedger: {
      events: [
        { id: 'event-a', timestamp: '2026-01-02T00:00:00.000Z', model: 'gpt-5', tokens: { input: 10, output: 20, total: 100 } },
      ],
    },
  }))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 10)
  assert.equal(usages[0].metrics?.tokensOutput, 90) // 20 + (100 - 30) folded
  assert.equal(usages[0].metrics?.tokensTotal, 100)
})

test('parity: ccusage amp reads_usage_from_messages_when_ledger_is_missing', async () => {
  // No usageLedger → fall back to per-assistant-message usage. ccusage asserts
  // output_tokens == 178 with cache 986/11372 (parser.rs reads_usage_from_messages_...).
  const usages = usageEvents(await parse({
    id: 'T-x',
    messages: [
      {
        role: 'assistant',
        usage: {
          model: 'claude-haiku-4-5-20251001',
          inputTokens: 10,
          outputTokens: 178,
          cacheCreationInputTokens: 986,
          cacheReadInputTokens: 11_372,
          timestamp: '2026-01-19T11:42:10.652Z',
        },
      },
    ],
  }))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].model, 'claude-haiku-4-5-20251001')
  assert.equal(usages[0].metrics?.tokensOutput, 178)
  // cache-inclusive input: 10 + 11372 (read) + 986 (write).
  assert.equal(usages[0].metrics?.tokensInput, 10 + 11_372 + 986)
  assert.equal(usages[0].metrics?.tokensCacheReadInput, 11_372)
  assert.equal(usages[0].metrics?.tokensCacheCreationInput, 986)
})

test('parity: ccusage amp empty_usage_ledger_falls_back_to_message_usage', async () => {
  // An empty/malformed usageLedger must not suppress the message-usage fallback.
  const usages = usageEvents(await parse({
    id: 'T-x',
    usageLedger: {},
    messages: [
      { role: 'assistant', usage: { model: 'gpt-5', outputTokens: 178, timestamp: '2026-01-19T11:42:10.652Z' } },
    ],
  }))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensOutput, 178)
})

test('amp still parses a normal ledger event unchanged', async () => {
  const usages = usageEvents(await parse({
    id: 'T-x',
    usageLedger: {
      events: [
        { id: 'e', timestamp: '2026-01-02T00:00:00.000Z', model: 'gpt-5', tokens: { input: 100, output: 50 } },
      ],
    },
  }))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[0].metrics?.tokensOutput, 50)
  assert.equal(usages[0].metrics?.tokensTotal, 150)
})
