import type { CanonicalEvent } from '@codetime/shared'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { createOpenCodeAdapter, opencodeUsageFromInfo } from '../src/adapters/opencode.ts'

// Build a minimal OpenCode SQLite DB with one session and its messages/parts,
// then run the adapter over it. `messages` is a list of [info, parts[]] tuples.
async function parseDb(
  messages: Array<[Record<string, unknown>, Record<string, unknown>[]]>,
): Promise<CanonicalEvent[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'opencode-'))
  const dbPath = path.join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT, title TEXT, time_created INTEGER, directory TEXT)')
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)')
  db.exec('CREATE TABLE part (id TEXT, message_id TEXT, data TEXT)')
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('ses_1', 't', 1000, '/w')
  let mi = 0
  for (const [info, parts] of messages) {
    const messageId = `msg_${mi}`
    const created = (info.time as { created?: number })?.created ?? 1000 + mi
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(messageId, 'ses_1', JSON.stringify(info), created)
    let pi = 0
    for (const part of parts) {
      db.prepare('INSERT INTO part VALUES (?, ?, ?)').run(`prt_${mi}_${pi}`, messageId, JSON.stringify(part))
      pi++
    }
    mi++
  }
  db.close()
  return createOpenCodeAdapter().parseSessionFile!(dbPath, { _: [] })
}

function usageEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  return events.filter(e => e.type === 'model.usage')
}

// ── billable-output token convention ──
//
// OpenCode reports reasoning tokens separately from output. codetime folds them
// into tokensOutput (billable output total) while keeping tokensReasoningOutput
// as the informational subset, and avoids double-counting reasoning in the total.

test('opencodeUsageFromInfo folds reasoning into billable tokensOutput', () => {
  const usage = opencodeUsageFromInfo({
    tokens: {
      input: 100,
      output: 40,
      reasoning: 15,
      cache: { read: 10, write: 5 },
    },
  })

  assert.ok(usage)
  // output (40) + reasoning (15) folded into the billable output total.
  assert.equal(usage.tokensOutput, 55)
  // reasoning stays exposed as the informational subset.
  assert.equal(usage.tokensReasoningOutput, 15)
  // tokensInput is cache-inclusive: 100 + 10 (read) + 5 (write).
  assert.equal(usage.tokensInput, 115)
  // total fallback = totalInput (115) + billableOutput (55), reasoning not added twice.
  assert.equal(usage.tokensTotal, 115 + 55)
})

test('opencodeUsageFromInfo honors an explicit upstream total', () => {
  const usage = opencodeUsageFromInfo({
    tokens: { input: 100, output: 40, reasoning: 15, total: 200, cache: { read: 0, write: 0 } },
  })

  assert.ok(usage)
  assert.equal(usage.tokensOutput, 55)
  assert.equal(usage.tokensTotal, 200)
})

// ── message-level tokens are authoritative; step-finish must not double-count ──
//
// ccusage counts only the message's own info.tokens (SELECT ... FROM message; it
// never reads the part table). Each step-finish part repeats those same tokens, so
// emitting model.usage for both inflated the turn ≥2×.

test('message-level tokens win; matching step-finish part does not double-count', async () => {
  const events = await parseDb([
    [
      { role: 'assistant', modelID: 'claude-sonnet-4', time: { created: 1000, completed: 1000 }, tokens: { input: 100, output: 50 }, finish: 'stop' },
      [{ type: 'step-finish', tokens: { input: 100, output: 50 } }],
    ],
  ])

  const usages = usageEvents(events)
  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 100)
  assert.equal(usages[0].metrics?.tokensOutput, 50)
  assert.equal(usages[0].operation, 'model usage')
})

test('step-finish tokens are used only when the message carries none of its own', async () => {
  const events = await parseDb([
    [
      { role: 'assistant', modelID: 'claude-sonnet-4', time: { created: 1000, completed: 1000 }, finish: 'stop' },
      [{ type: 'step-finish', tokens: { input: 30, output: 20 } }],
    ],
  ])

  const usages = usageEvents(events)
  assert.equal(usages.length, 1)
  assert.equal(usages[0].metrics?.tokensInput, 30)
  assert.equal(usages[0].metrics?.tokensOutput, 20)
  assert.equal(usages[0].operation, 'model usage (step)')
})
