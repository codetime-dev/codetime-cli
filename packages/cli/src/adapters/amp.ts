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
  const state = new SessionParserState(filePath, options, event => baseAmpEvent(event))
  state.sessionId = sessionId

  // Prefer the usage ledger. A thread with no ledger (older / other Amp schema)
  // still carries usage on each assistant message, so fall back to that instead of
  // dropping the whole thread — mirrors ccusage read_thread_file -> parse_message_usage.
  if (rawEvents.length === 0) {
    collectAmpMessageUsage(state, messages, sessionId, threadId, options)
    return state.events.filter(event => matchesBackfillFilters(event, options))
  }

  // Amp ledger entries can be written out of order; sort by timestamp so the
  // session/turn boundary derivations and final aggregation are stable.
  const events = [...rawEvents].sort((a, b) => {
    const ta = timestampFrom(stringField(a, 'timestamp')) || ''
    const tb = timestampFrom(stringField(b, 'timestamp')) || ''
    return ta.localeCompare(tb)
  })

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
    // Fold an explicit tokens.total that exceeds the itemized parts into billable
    // output (ccusage apply_total_token_fallback), so total-only ledger events —
    // {tokens:{total:N}} with no input/output — are counted instead of dropped.
    const { billableOutput, totalTokens } = foldAmpTotal(input, output, cacheRead, cacheWrite, numberField(tokens, 'total') || 0)
    if (totalTokens <= 0) {
      continue
    }

    const credits = numberField(ev, 'credits')
    const operationType = stringField(ev, 'operationType')
    const fromMessageId = numberField(ev, 'fromMessageId')

    const metrics: Partial<MetricBag> = {
      tokensInput: (input + cacheRead + cacheWrite) || undefined,
      tokensOutput: billableOutput || undefined,
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

// ccusage apply_total_token_fallback: when an explicit grand total exceeds the sum
// of the itemized token parts, attribute the shortfall to billable output (and the
// grand total). It never reduces the parts sum. Returns codetime's billable output
// (reasoning/extra folded in) and the reconciled grand total.
function foldAmpTotal(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  explicitTotal: number,
): { billableOutput: number, totalTokens: number } {
  const partsSum = input + output + cacheRead + cacheWrite
  const missing = Math.max(0, explicitTotal - partsSum)
  return { billableOutput: output + missing, totalTokens: partsSum + missing }
}

// Fallback usage path for Amp threads with no usage ledger: read each assistant
// message's own `usage` object (model/timestamp/inputTokens/outputTokens/
// cacheCreationInputTokens/cacheReadInputTokens/totalTokens). Mirrors ccusage
// parse_message_usage.
function collectAmpMessageUsage(
  state: SessionParserState,
  messages: Record<string, unknown>[],
  sessionId: string,
  threadId: string,
  _options: Record<string, unknown> & { _: string[] },
): void {
  const rows: Array<{
    ts: string
    model: string | undefined
    input: number
    billableOutput: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
  }> = []
  for (const message of messages) {
    if (stringField(message, 'role') !== 'assistant') {
      continue
    }
    const usage = objectField(message, 'usage')
    if (Object.keys(usage).length === 0) {
      continue
    }
    const ts = timestampFrom(stringField(usage, 'timestamp')) || timestampFrom(stringField(message, 'timestamp'))
    if (!ts) {
      continue
    }
    const model = stringField(usage, 'model') || stringField(message, 'model') || undefined
    const input = numberField(usage, 'inputTokens') || 0
    const output = numberField(usage, 'outputTokens') || 0
    const cacheWrite = numberField(usage, 'cacheCreationInputTokens') || 0
    const cacheRead = numberField(usage, 'cacheReadInputTokens') || 0
    const { billableOutput, totalTokens } = foldAmpTotal(input, output, cacheRead, cacheWrite, numberField(usage, 'totalTokens') || 0)
    if (totalTokens <= 0) {
      continue
    }
    rows.push({ ts, model, input, billableOutput, cacheRead, cacheWrite, totalTokens })
  }
  if (rows.length === 0) {
    return
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts))
  state.ensureSessionStarted(rows[0].ts, 0)
  let lastTs = rows[0].ts
  for (const [index, r] of rows.entries()) {
    lastTs = r.ts
    state.push(
      baseAmpEvent({
        ts: r.ts,
        type: 'model.usage',
        sessionId,
        model: r.model,
        confidence: 'exact',
        metrics: {
          tokensInput: (r.input + r.cacheRead + r.cacheWrite) || undefined,
          tokensOutput: r.billableOutput || undefined,
          tokensCachedInput: (r.cacheRead + r.cacheWrite) || undefined,
          tokensCacheReadInput: r.cacheRead || undefined,
          tokensCacheCreationInput: r.cacheWrite || undefined,
          tokensTotal: r.totalTokens,
          modelCalls: 1,
        },
        refs: stringRefs({ threadId }),
      }),
      index + 1,
      'messages',
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
    rows.length,
    'messages',
    'session',
  )
}

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
