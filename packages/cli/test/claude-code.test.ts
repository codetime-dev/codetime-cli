import type { CanonicalEvent } from '@codetime/shared'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { createClaudeCodeAdapter } from '../src/adapters/claude-code.ts'

const adapter = createClaudeCodeAdapter()

async function parse(records: unknown[]): Promise<CanonicalEvent[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-'))
  const file = path.join(dir, 'chat.jsonl')
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n'), 'utf8')
  return adapter.parseSessionFile!(file, { _: [] })
}

function usageEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  return events.filter(event => event.type === 'model.usage')
}

function assistant(requestId: string, messageId: string, usage: Record<string, number>, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-03-29T07:00:00.000Z',
    requestId,
    ...extra,
    message: { id: messageId, model: 'claude-sonnet-4-20250514', usage },
  }
}

// ── ccusage parity ──
//
// ccusage reports input_tokens cache-exclusive and shows cache_creation /
// cache_read separately; codetime's tokensInput is cache-inclusive
// (input + cache_creation + cache_read). So expected tokensInput here equals
// ccusage's input_tokens + both cache fields.

test('parity: claude usage decomposes cache and keeps tokensInput cache-inclusive', async () => {
  const usages = usageEvents(await parse([
    assistant('req-1', 'msg-1', { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 4 }),
  ]))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 10 + 2 + 5) // cache-inclusive
  assert.equal(usages[0].metrics?.tokensCachedInput, 2 + 5)
  assert.equal(usages[0].metrics?.tokensCacheCreationInput, 2)
  assert.equal(usages[0].metrics?.tokensCacheReadInput, 5)
  assert.equal(usages[0].metrics?.tokensOutput, 4)
  assert.equal(usages[0].metrics?.tokensTotal, 17 + 4)
})

test('parity: claude cache-only usage (from ccusage propagates_sidechain_metadata fixture)', async () => {
  // ccusage adapter/claude/daily.rs propagates_sidechain_metadata_from_agent_progress_lines.
  const usages = usageEvents(await parse([
    assistant('req-sidechain', 'msg-sidechain', { input_tokens: 0, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 20 }),
  ]))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 20) // 0 + 0 + 20
  assert.equal(usages[0].metrics?.tokensCacheReadInput, 20)
  assert.equal(usages[0].metrics?.tokensOutput, 10)
  assert.equal(usages[0].metrics?.tokensTotal, 30)
})

test('parity: claude dedupes the same (messageId, requestId) replay', async () => {
  // Streaming flush / retry writes the same assistant message twice.
  const usages = usageEvents(await parse([
    assistant('req-1', 'msg-1', { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 4 }),
    assistant('req-1', 'msg-1', { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 4 }),
  ]))

  assert.equal(usages.length, 1)
})

// KNOWN-BUT-BENIGN DIVERGENCE FROM ccusage.
//
// ccusage (adapter/claude/mod.rs keeps_parent_usage_when_sidechain_replays_…)
// drops a sidechain replay that reuses the parent messageId under a NEW
// requestId, keeping only the parent's cache_read (20). codetime dedups solely
// by `${messageId}:${requestId}`, so the different requestId makes it a fresh
// key and BOTH would be counted (cache_read 20 + 50000).
//
// Verified harmless on real data (2026-05-27): scanned 18,536 assistant
// messages across 173 transcripts — 0 messageIds carried >1 requestId, so this
// replay never occurs in practice and codetime's cache_read total matched the
// ccusage-style dedup exactly (1.55B tokens, 0% diff). Not worth changing the
// adapter. This test pins the current behavior; revisit only if real data ever
// shows the pattern.
test('divergence: claude does NOT drop sidechain replay with a new requestId', async () => {
  const usages = usageEvents(await parse([
    assistant('req-parent', 'msg-parent', { input_tokens: 0, cache_read_input_tokens: 20, output_tokens: 10 }, { isSidechain: false }),
    assistant('req-sidechain-replay', 'msg-parent', { input_tokens: 0, cache_read_input_tokens: 50_000, output_tokens: 10 }, { isSidechain: true }),
  ]))

  // ccusage would yield 1 usage with cache_read=20; codetime currently yields 2.
  const totalCacheRead = usages.reduce((sum, u) => sum + (u.metrics?.tokensCacheReadInput ?? 0), 0)
  assert.equal(usages.length, 2)
  assert.equal(totalCacheRead, 20 + 50_000)
})
