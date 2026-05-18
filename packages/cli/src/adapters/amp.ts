import type { CanonicalEvent, MetricBag } from '@codetime/shared'
import type { AdapterEnv, AgentAdapter, InstallEntry } from './types.js'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createWorkspaceId,
} from '@codetime/shared'
import { matchesBackfillFilters } from '../lib/backfill.js'
import {
  isPlainObject,
  numberField,
  objectField,
  stringField,
  stringRefs,
} from '../lib/fields.js'
import { listFilesByExtensions, pathExists } from '../lib/fs.js'
import { timestampFrom } from '../lib/jsonl.js'
import { SessionParserState } from '../lib/session-state.js'

interface BackfillSourceFile {
  path: string
  modifiedAt: string
}

// ── Parser ──

async function parseAmpSessionFile(
  filePath: string,
  options: Record<string, unknown> & { _: string[] },
): Promise<CanonicalEvent[]> {
  const text = await readFile(filePath, 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    return []
  }
  if (!isPlainObject(raw)) {
    return []
  }

  const threadId = stringField(raw, 'id') || path.basename(filePath, '.json')
  const sessionId = `amp_${threadId}`
  const messages = Array.isArray(raw.messages)
    ? raw.messages.filter(isPlainObject) as Record<string, unknown>[]
    : []
  const ledger = objectField(raw, 'usageLedger')
  const rawEvents = Array.isArray(ledger.events)
    ? ledger.events.filter(isPlainObject) as Record<string, unknown>[]
    : []
  if (rawEvents.length === 0) {
    return []
  }

  // Amp ledger entries can be written out of order; sort by timestamp so the
  // session/turn boundary derivations and final aggregation are stable.
  const events = [...rawEvents].sort((a, b) => {
    const ta = timestampFrom(stringField(a, 'timestamp')) || ''
    const tb = timestampFrom(stringField(b, 'timestamp')) || ''
    return ta.localeCompare(tb)
  })

  const state = new SessionParserState(filePath, options, event => baseAmpEvent(event))
  state.sessionId = sessionId

  const firstTs = timestampFrom(stringField(events[0], 'timestamp')) || new Date().toISOString()
  state.ensureSessionStarted(firstTs, 0)

  let lastTs = firstTs
  for (const [index, ev] of events.entries()) {
    const ts = timestampFrom(stringField(ev, 'timestamp')) || lastTs
    lastTs = ts
    const model = stringField(ev, 'model') || undefined
    const tokens = objectField(ev, 'tokens')
    const input = numberField(tokens, 'input') || 0
    const output = numberField(tokens, 'output') || 0
    const toMessageId = numberField(ev, 'toMessageId')
    const cache = cacheTokensFor(messages, toMessageId)
    const cacheRead = cache.cacheReadInputTokens
    const cacheWrite = cache.cacheCreationInputTokens
    const totalTokens = input + output + cacheRead + cacheWrite
    if (totalTokens <= 0) {
      continue
    }

    const credits = numberField(ev, 'credits')
    const operationType = stringField(ev, 'operationType')
    const fromMessageId = numberField(ev, 'fromMessageId')

    const metrics: Partial<MetricBag> = {
      tokensInput: (input + cacheRead + cacheWrite) || undefined,
      tokensOutput: output || undefined,
      tokensCachedInput: (cacheRead + cacheWrite) || undefined,
      tokensCacheReadInput: cacheRead || undefined,
      tokensCacheCreationInput: cacheWrite || undefined,
      tokensTotal: totalTokens,
      modelCalls: 1,
    }

    state.push(
      baseAmpEvent({
        ts,
        type: 'model.usage',
        sessionId,
        model,
        confidence: 'exact',
        metrics,
        refs: stringRefs({
          threadId,
          operationType,
          fromMessageId: fromMessageId === undefined ? undefined : String(fromMessageId),
          toMessageId: toMessageId === undefined ? undefined : String(toMessageId),
          // Credits are Amp's proprietary billing unit; preserved here so the
          // backend can correlate token counts with what the user is charged.
          credits: typeof credits === 'number' && Number.isFinite(credits)
            ? String(credits)
            : undefined,
        }),
      }),
      index + 1,
      'ledger',
      'model.usage',
    )
  }

  state.push(
    baseAmpEvent({
      ts: lastTs,
      type: 'session.ended',
      sessionId,
      confidence: 'derived',
    }),
    events.length,
    'ledger',
    'session',
  )

  return state.events.filter(event => matchesBackfillFilters(event, options))
}

// ── Amp-specific helpers ──

function baseAmpEvent(
  event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId'>,
): CanonicalEvent {
  return {
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    source: 'amp',
    agent: 'amp',
    // Amp threads carry no cwd/project metadata; pin all events to a stable
    // synthetic workspace so downstream rollups keep them grouped together.
    workspaceId: createWorkspaceId({ projectName: 'amp' }),
    ...event,
  }
}

function cacheTokensFor(
  messages: Record<string, unknown>[],
  toMessageId: number | undefined,
): {
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
} {
  if (toMessageId === undefined) {
    return { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  }
  const match = messages.find(message =>
    stringField(message, 'role') === 'assistant'
    && numberField(message, 'messageId') === toMessageId,
  )
  if (!match) {
    return { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  }
  const usage = objectField(match, 'usage')
  return {
    cacheReadInputTokens: numberField(usage, 'cacheReadInputTokens') || 0,
    cacheCreationInputTokens: numberField(usage, 'cacheCreationInputTokens') || 0,
  }
}

// ── Adapter factory ──

// Amp lets users relocate its data dir via AMP_DATA_DIR. ccusage matches that
// convention; we follow suit so identical environments work for both tools.
function ampDataDir(home: string, env?: AdapterEnv): string {
  const override = env?.AMP_DATA_DIR
  if (override && override.trim()) {
    return path.resolve(override)
  }
  return path.join(home, '.local', 'share', 'amp')
}

function ampThreadsDir(home: string, env?: AdapterEnv): string {
  return path.join(ampDataDir(home, env), 'threads')
}

export async function ampBackfillFiles(
  sourceRoot: string | undefined,
  home: string,
  env: AdapterEnv | undefined,
): Promise<BackfillSourceFile[]> {
  const root = sourceRoot ? path.resolve(sourceRoot) : ampThreadsDir(home, env)
  const files = await listFilesByExtensions(root, ['.json'])
  return Promise.all(files.map(async (filePath) => {
    const info = await stat(filePath)
    return { path: filePath, modifiedAt: info.mtime.toISOString() }
  }))
}

export function createAmpAdapter(): AgentAdapter {
  return {
    id: 'amp',
    label: 'Amp',
    agentName: 'amp',
    kind: 'agent',

    detectPath(home, env) {
      return ampDataDir(home, env)
    },
    // Amp has no plugin/hook surface, so there is nothing for codetime to
    // "install". Report installed = true whenever the threads dir is on disk
    // so `detect` accurately shows "already covered via backfill".
    installedPath(home, env) {
      return ampThreadsDir(home, env)
    },
    async isInstalled(home, env) {
      try {
        return await pathExists(ampThreadsDir(home, env))
      }
      catch {
        return false
      }
    },
    installEntries(): InstallEntry[] {
      return []
    },

    sourcePaths(home, env) {
      return [ampThreadsDir(home, env)]
    },

    parseSessionFile: parseAmpSessionFile,
  }
}
