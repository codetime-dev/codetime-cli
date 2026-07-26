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
  // No usage.cache_creation breakdown -> TTL split is left absent.
  assert.equal(usages[0].metrics?.tokensCacheCreation5mInput, undefined)
  assert.equal(usages[0].metrics?.tokensCacheCreation1hInput, undefined)
})

test('claude usage splits cache creation by TTL when usage.cache_creation is present', async () => {
  const usages = usageEvents(await parse([
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-03-29T07:00:00.000Z',
      requestId: 'req-ttl',
      message: {
        id: 'msg-ttl',
        model: 'claude-sonnet-4-20250514',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
          cache_read_input_tokens: 5,
          output_tokens: 4,
        },
      },
    },
  ]))

  assert.equal(usages.length, 1)
  // The total stays cache_creation_input_tokens; the split fills the subset fields.
  assert.equal(usages[0].metrics?.tokensCacheCreationInput, 300)
  assert.equal(usages[0].metrics?.tokensCacheCreation5mInput, 100)
  assert.equal(usages[0].metrics?.tokensCacheCreation1hInput, 200)
  // Cache-inclusive input and cached totals are unchanged by the split.
  assert.equal(usages[0].metrics?.tokensInput, 10 + 300 + 5)
  assert.equal(usages[0].metrics?.tokensCachedInput, 300 + 5)
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

// ── advisor-model iterations ──
//
// `message.usage.iterations[]` breaks an assistant message into the calls that
// produced it. Main-model (`type: "message"`) entries are already summed into the
// enclosing usage; `advisor_message` entries are a different model's call whose
// tokens the enclosing usage does not carry. Mirrors ccusage #1423.

test('parity: ccusage claude calculates_advisor_cost_with_the_advisor_model', async () => {
  // Fixture from ccusage adapter/claude/mod.rs
  // calculates_advisor_cost_with_the_advisor_model.
  const usages = usageEvents(await parse([
    assistant('req-parent', 'msg-parent', {
      input_tokens: 1,
      output_tokens: 2,
      iterations: [{
        type: 'advisor_message',
        model: 'advisor-model',
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }],
    } as unknown as Record<string, number>),
  ]))

  assert.equal(usages.length, 2)
  // The main model's totals are untouched.
  assert.equal(usages[0].model, 'claude-sonnet-4-20250514')
  assert.equal(usages[0].metrics?.tokensInput, 1)
  assert.equal(usages[0].metrics?.tokensOutput, 2)
  // The advisor's tokens are attributed to the advisor's own model.
  assert.equal(usages[1].model, 'advisor-model')
  assert.equal(usages[1].metrics?.tokensInput, 10)
  assert.equal(usages[1].metrics?.tokensOutput, 2)
  assert.equal(usages[1].metrics?.modelCalls, 1)
  // Distinct import identities, or the server would treat one as a repeat of the other.
  assert.notEqual(usages[0].id, usages[1].id)
  assert.notEqual(usages[0].refs?.importKey, usages[1].refs?.importKey)
})

test('main-model iterations are never counted twice', async () => {
  // Real transcripts carry a `type: "message"` iteration whose counts equal the
  // enclosing usage exactly (verified across 201 such lines locally). Expanding
  // those would double every assistant message. Today those entries carry no
  // `model`, but the type check — not the missing field — has to be what stops
  // them, so this fixture supplies a model the filter must ignore.
  const usages = usageEvents(await parse([
    assistant('req-1', 'msg-1', {
      input_tokens: 2,
      output_tokens: 234,
      cache_creation_input_tokens: 29_586,
      cache_read_input_tokens: 0,
      iterations: [{
        type: 'message',
        model: 'claude-sonnet-4-20250514',
        input_tokens: 2,
        output_tokens: 234,
        cache_creation_input_tokens: 29_586,
        cache_read_input_tokens: 0,
      }],
    } as unknown as Record<string, number>),
  ]))

  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensOutput, 234)
})

test('advisor iterations inherit the TTL split and skip malformed entries', async () => {
  const usages = usageEvents(await parse([
    assistant('req-1', 'msg-1', {
      input_tokens: 1,
      output_tokens: 2,
      iterations: [
        // No model → cannot be priced, so it is not emitted.
        { type: 'advisor_message', input_tokens: 5, output_tokens: 1 },
        // Not an object.
        'garbage',
        {
          type: 'advisor_message',
          model: 'advisor-model',
          input_tokens: 3,
          output_tokens: 1,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 7,
          cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
        },
      ],
    } as unknown as Record<string, number>),
  ]))

  assert.equal(usages.length, 2)
  const advisor = usages[1]
  assert.equal(advisor.model, 'advisor-model')
  assert.equal(advisor.metrics?.tokensInput, 3 + 100 + 7) // cache-inclusive
  assert.equal(advisor.metrics?.tokensCacheCreation5mInput, 40)
  assert.equal(advisor.metrics?.tokensCacheCreation1hInput, 60)
})

test('two advisor iterations on one line get distinct import identities', async () => {
  const events = await parse([
    assistant('req-1', 'msg-1', {
      input_tokens: 1,
      output_tokens: 2,
      iterations: [
        { type: 'advisor_message', model: 'advisor-a', input_tokens: 3, output_tokens: 1 },
        { type: 'advisor_message', model: 'advisor-b', input_tokens: 4, output_tokens: 1 },
      ],
    } as unknown as Record<string, number>),
  ])

  const usages = usageEvents(events)
  assert.equal(usages.length, 3)
  assert.equal(new Set(usages.map(usage => usage.id)).size, 3)
})

test('a duplicate assistant entry does not re-emit its advisor usage', async () => {
  // The (messageId, requestId) dedup skips the whole entry, advisors included.
  const usages = usageEvents(await parse([
    assistant('req-1', 'msg-1', {
      input_tokens: 1,
      output_tokens: 2,
      iterations: [{ type: 'advisor_message', model: 'advisor-model', input_tokens: 10, output_tokens: 2 }],
    } as unknown as Record<string, number>),
    assistant('req-1', 'msg-1', {
      input_tokens: 1,
      output_tokens: 2,
      iterations: [{ type: 'advisor_message', model: 'advisor-model', input_tokens: 10, output_tokens: 2 }],
    } as unknown as Record<string, number>),
  ]))

  assert.equal(usages.length, 2)
})
