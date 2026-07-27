import type { CanonicalEvent } from '@codetime/shared'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { createKimiAdapter, kimiBackfillFiles } from '../src/adapters/kimi.ts'

const adapter = createKimiAdapter()

// Build a Kimi data root on disk. Keys are paths relative to the root, so the
// sessions/<...>/wire.jsonl nesting that drives both discovery and session-id
// extraction is exercised for real rather than stubbed.
async function kimiRoot(files: Record<string, string | unknown[]>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimi-'))
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(
      target,
      Array.isArray(content) ? content.map(line => JSON.stringify(line)).join('\n') : content,
      'utf8',
    )
  }
  return root
}

function usageEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  return events.filter(event => event.type === 'model.usage')
}

async function parseWire(root: string, relative: string): Promise<CanonicalEvent[]> {
  return adapter.parseSessionFile!(path.join(root, relative), { _: [] })
}

// ── new Kimi Code wire format (`usage.record`) ──

test('parity: ccusage kimi loads_kimi_code_usage_record_format', async () => {
  // Fixture from ccusage adapter/kimi/loader.rs loads_kimi_code_usage_record_format.
  const wire = 'sessions/workspace/session-b/agents/agent-1/wire.jsonl'
  const root = await kimiRoot({
    [wire]: [
      { type: 'usage.record', model: 'kimi-code/kimi-for-coding', usage: { inputOther: 3064, output: 76, inputCacheRead: 14_848, inputCacheCreation: 0 }, usageScope: 'turn', time: 1_782_113_184_943 },
      // Session-scoped records are cumulative — counting them doubles the session.
      { type: 'usage.record', model: 'kimi-code/kimi-for-coding', usage: { inputOther: 5000, output: 200, inputCacheRead: 20_000, inputCacheCreation: 100 }, usageScope: 'session', time: 1_782_113_185_000 },
    ],
  })

  const usages = usageEvents(await parseWire(root, wire))
  assert.equal(usages.length, 1, 'session-scoped record must be skipped')
  assert.equal(usages[0].sessionId, 'kimi_session-b')
  // The `kimi-code/` provider route is stripped for pricing lookups.
  assert.equal(usages[0].model, 'kimi-for-coding')
  // ccusage keeps input_tokens cache-exclusive (3064); codetime's tokensInput is
  // cache-inclusive, so it folds both cache buckets back in.
  assert.equal(usages[0].metrics?.tokensInput, 3064 + 14_848)
  assert.equal(usages[0].metrics?.tokensCacheReadInput, 14_848)
  assert.equal(usages[0].metrics?.tokensCacheCreationInput, undefined) // 0 → absent
  assert.equal(usages[0].metrics?.tokensOutput, 76)
  assert.equal(usages[0].metrics?.tokensTotal, 3064 + 14_848 + 76)
  // `time` is epoch MILLISECONDS in this format.
  assert.equal(usages[0].ts, new Date(1_782_113_184_943).toISOString())
})

// ── old StatusUpdate wire format ──

test('parity: ccusage kimi loads_status_update_token_usage_from_wire_files', async () => {
  // Fixture from ccusage adapter/kimi/loader.rs
  // loads_status_update_token_usage_from_wire_files.
  const wire = 'sessions/group/session-a/wire.jsonl'
  const root = await kimiRoot({
    'config.json': '{"model":"kimi-k2"}',
    [wire]: [
      { type: 'metadata', protocol_version: '1.3' },
      { timestamp: 1_770_983_426.420_942, message: { type: 'TurnBegin', payload: { user_input: 'hello' } } },
      { timestamp: 1_770_983_427.123, message: { type: 'StatusUpdate', payload: { token_usage: { input_other: 100, output: 50, input_cache_read: 10, input_cache_creation: 20 }, message_id: 'msg-1' } } },
    ],
  })

  const usages = usageEvents(await parseWire(root, wire))
  assert.equal(usages.length, 1)
  assert.equal(usages[0].sessionId, 'kimi_session-a')
  // The old format names no model per line, so config.json is the only source.
  assert.equal(usages[0].model, 'kimi-k2')
  assert.equal(usages[0].metrics?.tokensInput, 100 + 10 + 20)
  assert.equal(usages[0].metrics?.tokensCacheReadInput, 10)
  assert.equal(usages[0].metrics?.tokensCacheCreationInput, 20)
  assert.equal(usages[0].metrics?.tokensOutput, 50)
  // `timestamp` is epoch SECONDS (fractional) in this format.
  assert.equal(usages[0].ts, new Date(1_770_983_427_123).toISOString())
})

test('kimi falls back to kimi-for-coding when config.json names no model', async () => {
  const wire = 'sessions/group/session-a/wire.jsonl'
  const root = await kimiRoot({
    [wire]: [
      { timestamp: 1_770_983_427, message: { type: 'StatusUpdate', payload: { token_usage: { input_other: 5, output: 1 } } } },
    ],
  })

  assert.equal(usageEvents(await parseWire(root, wire))[0].model, 'kimi-for-coding')
})

test('parity: ccusage kimi falls_back_to_total_tokens_when_kimi_parts_are_missing', async () => {
  // An explicit total can only ADD tokens the parts do not account for, folded
  // into billable output; it can never shrink the parts sum.
  const wire = 'sessions/group/session-a/wire.jsonl'
  const root = await kimiRoot({
    [wire]: [
      { timestamp: 1_770_983_427, message: { type: 'StatusUpdate', payload: { token_usage: { input_other: 100, output: 0, total: 150 } } } },
      // An undersized total must not shrink anything.
      { timestamp: 1_770_983_428, message: { type: 'StatusUpdate', payload: { token_usage: { input_other: 100, output: 40, total: 10 } } } },
    ],
  })

  const usages = usageEvents(await parseWire(root, wire))
  assert.equal(usages.length, 2)
  assert.equal(usages[0].metrics?.tokensOutput, 50) // 150 - 100 folded into output
  assert.equal(usages[0].metrics?.tokensTotal, 150)
  assert.equal(usages[1].metrics?.tokensOutput, 40)
  assert.equal(usages[1].metrics?.tokensTotal, 140) // parts win over the small total
})

test('parity: ccusage kimi skips_malformed_and_zero_token_wire_lines', async () => {
  const wire = 'sessions/group/session-a/wire.jsonl'
  const root = await kimiRoot({
    [wire]: [
      'not json',
      JSON.stringify({ timestamp: 1_770_983_427, message: { type: 'StatusUpdate', payload: { token_usage: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 } } } }),
    ].join('\n'),
  })

  assert.deepEqual(await parseWire(root, wire), [])
})

test('kimi degrades an unusable timestamp to the file mtime instead of dropping the line', async () => {
  const wire = 'sessions/group/session-a/wire.jsonl'
  const root = await kimiRoot({
    [wire]: [
      { type: 'usage.record', usageScope: 'turn', time: 'not-a-number', usage: { inputOther: 10, output: 2 } },
    ],
  })

  const usages = usageEvents(await parseWire(root, wire))
  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 10)
  assert.ok(!Number.isNaN(Date.parse(usages[0].ts!)))
})

// ── wire-file discovery ──

test('parity: ccusage kimi discovers both layouts and skips non-wire files', async () => {
  // From ccusage adapter/kimi/paths.rs
  // discovers_both_old_and_new_layouts_and_skips_non_wire_files.
  const root = await kimiRoot({
    'sessions/ws/session-c/agents/agent-1/wire.jsonl': '{}',
    'sessions/ws/session-c/agents/agent-1/other.jsonl': '{}',
    'sessions/group/session-d/wire.jsonl': '{}',
    // 4 segments — neither layout, so it must not be picked up.
    'sessions/nested/path/session/wire.jsonl': '{}',
  })

  const files = await kimiBackfillFiles(undefined, '/nonexistent-home', { KIMI_DATA_DIR: root })
  assert.deepEqual(files.map(file => path.relative(root, file.path)), [
    path.join('sessions', 'group', 'session-d', 'wire.jsonl'),
    path.join('sessions', 'ws', 'session-c', 'agents', 'agent-1', 'wire.jsonl'),
  ])
})

test('KIMI_DATA_DIR replaces the default roots rather than adding to them', async () => {
  const root = await kimiRoot({ 'sessions/group/session-a/wire.jsonl': '{}' })
  const home = await kimiRoot({ '.kimi/sessions/group/session-home/wire.jsonl': '{}' })

  const overridden = await kimiBackfillFiles(undefined, home, { KIMI_DATA_DIR: root })
  assert.deepEqual(overridden.map(file => path.relative(root, file.path)), [
    path.join('sessions', 'group', 'session-a', 'wire.jsonl'),
  ])

  // Without the override the home roots are what gets searched.
  const fromHome = await kimiBackfillFiles(undefined, home, {})
  assert.deepEqual(fromHome.map(file => path.relative(home, file.path)), [
    path.join('.kimi', 'sessions', 'group', 'session-home', 'wire.jsonl'),
  ])
})

test('kimi emits one session.started per wire file, before the first usage', async () => {
  const wire = 'sessions/ws/session-b/agents/agent-1/wire.jsonl'
  const root = await kimiRoot({
    [wire]: [
      { type: 'usage.record', usageScope: 'turn', time: 1_782_113_184_943, usage: { inputOther: 10, output: 2 } },
      { type: 'usage.record', usageScope: 'turn', time: 1_782_113_185_943, usage: { inputOther: 20, output: 4 } },
    ],
  })

  const events = await parseWire(root, wire)
  const started = events.filter(event => event.type === 'session.started')
  assert.equal(started.length, 1)
  assert.equal(events[0].type, 'session.started')
  assert.equal(started[0].sessionId, 'kimi_session-b')
  assert.equal(usageEvents(events).length, 2)
})

test('kimi usage events on one file carry distinct import identities', async () => {
  const wire = 'sessions/group/session-a/wire.jsonl'
  const root = await kimiRoot({
    [wire]: [
      { type: 'usage.record', usageScope: 'turn', time: 1_782_113_184_943, usage: { inputOther: 10, output: 2 } },
      { type: 'usage.record', usageScope: 'turn', time: 1_782_113_185_943, usage: { inputOther: 10, output: 2 } },
    ],
  })

  const usages = usageEvents(await parseWire(root, wire))
  assert.equal(usages.length, 2)
  assert.equal(new Set(usages.map(usage => usage.id)).size, 2)
})
