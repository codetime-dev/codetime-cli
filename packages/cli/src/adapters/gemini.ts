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
  arrayField,
  isPlainObject,
  numberField,
  objectField,
  stringField,
  stringRefs,
} from '../lib/fields.js'
import { listFilesByExtensions, pathExists } from '../lib/fs.js'
import { parseJsonLine, timestampFrom } from '../lib/jsonl.js'
import { SessionParserState } from '../lib/session-state.js'

interface BackfillSourceFile {
  path: string
  modifiedAt: string
}

// Raw token shape mirrored from ccusage's gemini parser. Gemini exposes only a
// `cached` (read) count — there is no cache-creation concept — and a separate
// `tool`/`thoughts` split that we fold into input/reasoning respectively.
interface GeminiTokens {
  input: number
  output: number
  cached: number
  thoughts: number
  tool: number
  total?: number
}

// A single normalized usage record. `tokensInput` already follows codetime's
// convention (cache-inclusive); see buildUsage().
interface GeminiUsage {
  ts: string
  model: string
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensReasoning: number
  tokensTotal: number
  id?: string
}

interface ParsedFile {
  sessionId: string
  usages: GeminiUsage[]
}

// ── Token extraction ──

function tokenFromKeys(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = numberField(record, key)
    if (value !== undefined) {
      return Math.max(0, Math.trunc(value))
    }
  }
  return 0
}

function parseTokens(value: unknown): GeminiTokens | undefined {
  if (!isPlainObject(value)) {
    return undefined
  }
  const totalRaw = numberField(value, 'total') ?? numberField(value, 'total_tokens')
  return {
    input: tokenFromKeys(value, ['input', 'prompt', 'input_tokens', 'prompt_tokens']),
    output: tokenFromKeys(value, ['output', 'candidates', 'output_tokens', 'candidates_tokens']),
    cached: tokenFromKeys(value, ['cached', 'cached_tokens']),
    thoughts: tokenFromKeys(value, ['thoughts', 'reasoning', 'thoughts_tokens', 'reasoning_tokens']),
    tool: tokenFromKeys(value, ['tool', 'tool_tokens']),
    total: totalRaw === undefined ? undefined : Math.max(0, Math.trunc(totalRaw)),
  }
}

// ── Cache normalization ──
//
// Gemini sometimes reports `input` already inclusive of cached tokens and
// sometimes exclusive. These two strategies match ccusage exactly.

/** Stats blocks always count cache inside `input`; peel it back out. */
function subtractCachedOverlap(tokens: GeminiTokens): [number, number] {
  const cacheRead = tokens.cached
  const cachedPortion = Math.min(tokens.input, cacheRead)
  return [tokens.input - cachedPortion, cacheRead]
}

/**
 * Direct events only fold cache into `input` when the reported `total` proves
 * it (total equals the cache-exclusive sum but not the cache-inclusive one).
 * Otherwise input is taken at face value.
 */
function normalizeSessionInput(tokens: GeminiTokens): [number, number] {
  const inclusive = tokens.input + tokens.output + tokens.thoughts + tokens.tool
  const exclusive = inclusive + tokens.cached
  if (tokens.cached > 0 && tokens.total === inclusive && tokens.total !== exclusive) {
    return subtractCachedOverlap(tokens)
  }
  return [tokens.input, tokens.cached]
}

function buildUsage(
  model: string | undefined,
  ts: string,
  tokens: GeminiTokens,
  normalize: (tokens: GeminiTokens) => [number, number],
  id: string | undefined,
): GeminiUsage | undefined {
  const finalModel = model?.trim()
  if (!finalModel) {
    return undefined
  }

  const [inputWithoutCache, cacheRead] = normalize(tokens)
  const inputTokens = inputWithoutCache + tokens.tool
  const totalTokens = tokens.total
    ?? (inputTokens + tokens.output + cacheRead + tokens.thoughts)

  // apply_total_token_fallback: if the parts undercount `total`, attribute the
  // gap to output (when output is empty) or otherwise to reasoning.
  let output = tokens.output
  let reasoning = tokens.thoughts
  const known = inputTokens + output + cacheRead + reasoning
  const missing = Math.max(0, totalTokens - known)
  if (missing > 0) {
    if (output === 0) {
      output = missing
    }
    else {
      reasoning += missing
    }
  }

  if (inputTokens === 0 && output === 0 && cacheRead === 0 && reasoning === 0) {
    return undefined
  }

  return {
    ts,
    model: finalModel,
    // codetime convention: tokensInput is cache-inclusive (see amp adapter).
    tokensInput: inputTokens + cacheRead,
    tokensOutput: output,
    tokensCacheRead: cacheRead,
    tokensReasoning: reasoning,
    tokensTotal: totalTokens,
    id,
  }
}

// ── Per-record parsers ──

function parseDirectEvent(
  record: Record<string, unknown>,
  modelHint: string | undefined,
  fallbackTs: string,
): GeminiUsage | undefined {
  const tokens = parseTokens(record.tokens)
  if (!tokens) {
    return undefined
  }
  const ts = timestampFrom(stringField(record, 'timestamp'))
    ?? timestampFrom(stringField(record, 'created_at'))
    ?? fallbackTs
  const model = stringField(record, 'model') ?? modelHint
  return buildUsage(model, ts, tokens, normalizeSessionInput, stringField(record, 'id'))
}

function parseStatsEvents(
  stats: unknown,
  modelHint: string | undefined,
  ts: string,
): GeminiUsage[] {
  if (!isPlainObject(stats)) {
    return []
  }
  const models = objectField(stats, 'models')
  const perModel = Object.entries(models)
    .filter((entry): entry is [string, Record<string, unknown>] => isPlainObject(entry[1]))
    .map(([model, data]) => {
      const tokens = parseTokens(data.tokens)
      return tokens
        ? buildUsage(model, ts, tokens, subtractCachedOverlap, undefined)
        : undefined
    })
    .filter((usage): usage is GeminiUsage => usage !== undefined)
  if (perModel.length > 0) {
    return perModel
  }

  // Fall back to treating the stats object itself as a token bag.
  const tokens = parseTokens(stats)
  if (!tokens) {
    return []
  }
  const usage = buildUsage(modelHint ?? 'unknown', ts, tokens, subtractCachedOverlap, undefined)
  return usage ? [usage] : []
}

function readStats(record: Record<string, unknown>): unknown {
  if (isPlainObject(record.stats)) {
    return record.stats
  }
  const result = record.result
  if (isPlainObject(result) && isPlainObject(result.stats)) {
    return result.stats
  }
  return undefined
}

// ── File parsers ──

function parseJsonRecord(
  record: Record<string, unknown>,
  fileStem: string,
  fallbackTs: string,
): ParsedFile {
  const sessionId = stringField(record, 'sessionId')
    ?? stringField(record, 'session_id')
    ?? fileStem
  const sessionTs = timestampFrom(stringField(record, 'startTime'))
    ?? timestampFrom(stringField(record, 'lastUpdated'))
    ?? fallbackTs

  const messages = arrayField(record, 'messages').filter(isPlainObject)
  if (messages.length > 0) {
    const usages = messages
      .filter(message => stringField(message, 'type') === 'gemini')
      .map(message => parseDirectEvent(message, undefined, sessionTs))
      .filter((usage): usage is GeminiUsage => usage !== undefined)
    return { sessionId, usages }
  }

  if (stringField(record, 'type') === 'gemini') {
    const usage = parseDirectEvent(record, undefined, fallbackTs)
    return { sessionId, usages: usage ? [usage] : [] }
  }

  const statsTs = timestampFrom(stringField(record, 'timestamp')) ?? fallbackTs
  return {
    sessionId,
    usages: parseStatsEvents(readStats(record), stringField(record, 'model'), statsTs),
  }
}

function parseJsonlRecords(
  lines: string[],
  fileStem: string,
  fallbackTs: string,
): ParsedFile {
  let sessionId = fileStem
  let currentModel: string | undefined
  const usages: GeminiUsage[] = []
  // Direct events carry an `id`; a later line with the same id supersedes the
  // earlier one, matching ccusage's last-write-wins dedup.
  const directIndexes = new Map<string, number>()

  for (const line of lines) {
    const record = parseJsonLine(line)
    if (!record) {
      continue
    }
    const sid = stringField(record, 'sessionId') ?? stringField(record, 'session_id')
    if (sid) {
      sessionId = sid
    }
    const model = stringField(record, 'model')
    if (model) {
      currentModel = model
    }

    if (stringField(record, 'type') === 'gemini') {
      const usage = parseDirectEvent(record, currentModel, fallbackTs)
      if (!usage) {
        continue
      }
      const id = stringField(record, 'id')
      if (id === undefined) {
        usages.push(usage)
      }
      else {
        const existing = directIndexes.get(id)
        if (existing === undefined) {
          directIndexes.set(id, usages.length)
          usages.push(usage)
        }
        else {
          usages[existing] = usage
        }
      }
      continue
    }

    const stats = readStats(record)
    if (stats !== undefined) {
      const statsTs = timestampFrom(stringField(record, 'timestamp')) ?? fallbackTs
      usages.push(...parseStatsEvents(stats, currentModel, statsTs))
    }
  }

  return { sessionId, usages }
}

async function parseGeminiSessionFile(
  filePath: string,
  options: Record<string, unknown> & { _: string[] },
): Promise<CanonicalEvent[]> {
  const text = await readFile(filePath, 'utf8')
  const fileStem = path.basename(filePath).replace(/\.jsonl?$/, '')
  const info = await stat(filePath)
  const fallbackTs = info.mtime.toISOString()

  let parsed: ParsedFile
  if (filePath.endsWith('.jsonl')) {
    parsed = parseJsonlRecords(text.split('\n'), fileStem, fallbackTs)
  }
  else {
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
    parsed = parseJsonRecord(raw, fileStem, fallbackTs)
  }

  if (parsed.usages.length === 0) {
    return []
  }

  // Gemini records can be written out of order; sort so session boundaries and
  // aggregation are stable.
  const usages = parsed.usages.sort((a, b) => a.ts.localeCompare(b.ts))
  const sessionId = `gemini_${parsed.sessionId}`

  const state = new SessionParserState(filePath, options, event => baseGeminiEvent(event))
  state.sessionId = sessionId
  state.ensureSessionStarted(usages[0].ts, 0)

  let lastTs = usages[0].ts
  for (const [index, usage] of usages.entries()) {
    lastTs = usage.ts
    const metrics: Partial<MetricBag> = {
      tokensInput: usage.tokensInput || undefined,
      tokensOutput: usage.tokensOutput || undefined,
      tokensCachedInput: usage.tokensCacheRead || undefined,
      tokensCacheReadInput: usage.tokensCacheRead || undefined,
      tokensReasoningOutput: usage.tokensReasoning || undefined,
      tokensTotal: usage.tokensTotal,
      modelCalls: 1,
    }
    state.push(
      baseGeminiEvent({
        ts: usage.ts,
        type: 'model.usage',
        sessionId,
        model: usage.model,
        confidence: 'exact',
        metrics,
        refs: stringRefs({ messageId: usage.id }),
      }),
      index + 1,
      'jsonl',
      'model.usage',
    )
  }

  state.push(
    baseGeminiEvent({
      ts: lastTs,
      type: 'session.ended',
      sessionId,
      confidence: 'derived',
    }),
    usages.length,
    'jsonl',
    'session',
  )

  return state.events.filter(event => matchesBackfillFilters(event, options))
}

// ── Adapter factory ──

function baseGeminiEvent(
  event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId'>,
): CanonicalEvent {
  return {
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    source: 'gemini',
    agent: 'gemini',
    // Gemini logs carry no cwd/project metadata; pin all events to a stable
    // synthetic workspace so downstream rollups keep them grouped together.
    workspaceId: createWorkspaceId({ projectName: 'gemini' }),
    ...event,
  }
}

// Gemini CLI honors GEMINI_DATA_DIR (comma-separated dirs); fall back to the
// default ~/.gemini/tmp. ccusage matches this convention.
function geminiDataDirs(home: string, env?: AdapterEnv): string[] {
  const override = env?.GEMINI_DATA_DIR
  if (override && override.trim()) {
    return override
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => path.resolve(entry))
  }
  return [path.join(home, '.gemini', 'tmp')]
}

export async function geminiBackfillFiles(
  sourceRoot: string | undefined,
  home: string,
  env: AdapterEnv | undefined,
): Promise<BackfillSourceFile[]> {
  const roots = sourceRoot ? [path.resolve(sourceRoot)] : geminiDataDirs(home, env)
  const fileLists = await Promise.all(
    roots.map(root => listFilesByExtensions(root, ['.json', '.jsonl'])),
  )
  const files = fileLists.flat().sort()
  return Promise.all(files.map(async (filePath) => {
    const info = await stat(filePath)
    return { path: filePath, modifiedAt: info.mtime.toISOString() }
  }))
}

export function createGeminiAdapter(): AgentAdapter {
  return {
    id: 'gemini',
    label: 'Gemini CLI',
    agentName: 'gemini',
    kind: 'agent',

    detectPath(home, env) {
      return geminiDataDirs(home, env)[0]
    },
    // Gemini has no plugin/hook surface, so there is nothing for codetime to
    // "install". Report installed = true whenever a data dir is on disk so
    // `detect` accurately shows "already covered via backfill".
    installedPath(home, env) {
      return geminiDataDirs(home, env)[0]
    },
    async isInstalled(home, env) {
      for (const dir of geminiDataDirs(home, env)) {
        if (await pathExists(dir).catch(() => false)) {
          return true
        }
      }
      return false
    },
    installEntries(): InstallEntry[] {
      return []
    },

    sourcePaths(home, env) {
      return geminiDataDirs(home, env)
    },

    parseSessionFile: parseGeminiSessionFile,
  }
}
