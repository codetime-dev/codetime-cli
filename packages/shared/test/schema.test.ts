import type {
  StoredCanonicalEvent,
} from '../src/index.ts'
import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import { it } from 'node:test'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createImportKey,
  createPayloadHash,
  createStableEventId,
  createWorkspaceId,
  durationMs,
  getSourceCapabilities,
  normalizeCanonicalEvent,
  summarizeCanonicalEvents,
  validateCanonicalEvent,
} from '../src/index.ts'

it('normalizes canonical events', () => {
  const event = normalizeCanonicalEvent({
    schemaVersion: '',
    ts: '',
    source: '',
    type: 'agent.operation',
    fileActivities: [
      { ts: '2026-04-29T00:00:00.000Z', path: 'src/index.ts', operation: 'edit' },
      { ts: '2026-04-29T00:00:00.000Z', path: '', operation: 'edit' },
    ],
  })

  assert.equal(event.schemaVersion, AGENT_TIME_SCHEMA_VERSION)
  assert.equal(event.source, 'unknown')
  assert.equal(event.fileActivities?.length, 1)
})

it('summarizes canonical file activity without double-counting aggregate metrics', () => {
  const event: StoredCanonicalEvent = {
    id: 'e1',
    receivedAt: '2026-04-29T00:00:00.000Z',
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    ts: '2026-04-29T00:00:00.000Z',
    source: 'codex',
    agent: 'codex',
    type: 'file.changed',
    project: 'agent-time',
    sessionId: 's1',
    fileActivities: [
      {
        ts: '2026-04-29T00:00:00.000Z',
        path: 'src/index.ts',
        operation: 'edit',
        linesAdded: 4,
        linesRemoved: 1,
      },
    ],
    metrics: {
      linesAdded: 4,
      linesRemoved: 1,
    },
  }

  const summary = summarizeCanonicalEvents([event])

  assert.equal(summary.totalEvents, 1)
  assert.equal(summary.totalSessions, 1)
  assert.equal(summary.totalProjects, 1)
  assert.equal(summary.totalFilesTouched, 1)
  assert.equal(summary.totalLinesAdded, 4)
  assert.equal(summary.bySource.codex, 1)
})

it('uses aggregate line metrics when file activities do not carry line counts', () => {
  const event: StoredCanonicalEvent = {
    id: 'e1',
    receivedAt: '2026-04-29T00:00:00.000Z',
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    ts: '2026-04-29T00:00:00.000Z',
    source: 'manual',
    agent: 'codex',
    type: 'file.changed',
    project: 'agent-time',
    fileActivities: [
      {
        ts: '2026-04-29T00:00:00.000Z',
        path: 'src/index.ts',
        operation: 'edit',
      },
    ],
    metrics: {
      linesAdded: 4,
      linesRemoved: 1,
    },
  }

  const summary = summarizeCanonicalEvents([event])

  assert.equal(summary.totalFilesTouched, 1)
  assert.equal(summary.totalLinesAdded, 4)
  assert.equal(summary.totalLinesRemoved, 1)
})

it('validates canonical event type and file activity operation at runtime', () => {
  const validation = validateCanonicalEvent({
    source: 'codex',
    type: 'not.real',
    fileActivities: [
      { ts: '2026-04-29T00:00:00.000Z', path: 'src/index.ts', operation: 'peek' },
    ],
  })

  assert.equal(validation.valid, false)
  assert.match(validation.errors.join('\n'), /supported telemetry event type/)
  assert.match(validation.errors.join('\n'), /supported file activity operation/)
})

it('exposes source capabilities and small shared helpers', () => {
  assert.equal(getSourceCapabilities('claude-code').toolCalls, 'exact')
  assert.equal(durationMs('2026-04-29T00:00:00.000Z', '2026-04-29T00:00:01.500Z'), 1500)
  assert.equal(createWorkspaceId({ repoRoot: '/tmp/project' }), createWorkspaceId({ repoRoot: '/tmp/project' }))
})

it('creates stable import keys, event ids, and payload hashes', () => {
  const importKey = createImportKey(['codex', 'source-file', 42])
  const eventId = createStableEventId(importKey)
  const payloadHash = createPayloadHash({
    id: eventId,
    refs: {
      importKey,
      payloadHash: 'ignored',
    },
    receivedAt: 'ignored',
  })
  const samePayloadHash = createPayloadHash({
    refs: {
      importKey,
    },
    id: eventId,
  })

  assert.equal(importKey, 'codex:source-file:42')
  assert.match(eventId, /^evt_[0-9a-f]{24}$/)
  assert.equal(payloadHash, samePayloadHash)
})
