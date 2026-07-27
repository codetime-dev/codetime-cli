import type { CanonicalEvent, MetricBag } from '@codetime/shared'
import type { AdapterEnv, AgentAdapter, InstallEntry } from './types.js'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createStableHash,
  createWorkspaceId,
} from '@codetime/shared'
import { withBackfillRefs } from '../lib/backfill.js'
import {
  numberField,
  objectField,
  stringField,
} from '../lib/fields.js'
import { listFilesByExtensions, pathExists } from '../lib/fs.js'
import { parseJsonLine } from '../lib/jsonl.js'

interface BackfillSourceFile {
  path: string
  modifiedAt: string
}

// Kimi writes one `wire.jsonl` per agent run under a sessions tree. Two layouts
// exist and both are still on disk in the wild:
//   old: <root>/sessions/<group>/<session>/wire.jsonl                    (3 segments)
//   new: <root>/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl (5 segments)
// Mirrors ccusage is_kimi_wire_file (adapter/kimi/paths.rs).
const KIMI_SESSIONS_DIR = 'sessions'
const KIMI_WIRE_FILE = 'wire.jsonl'
const KIMI_WIRE_DEPTHS = new Set([3, 5])

// The subscription tier name Kimi reports when config.json names no model.
// ccusage maps this to a concrete moonshot/kimi-k2.x id via a hardcoded release
// cutoff so its offline pricing table can resolve a rate. codetime prices on the
// server from OpenRouter instead, so the raw name is stored as-is rather than
// baked against a timestamp that goes stale.
const KIMI_DEFAULT_MODEL = 'kimi-for-coding'

// ── Paths ──

function kimiDataDirs(home: string, env?: AdapterEnv): string[] {
  const configured = env?.KIMI_DATA_DIR
  if (configured) {
    // Explicit override wins outright, matching ccusage: when KIMI_DATA_DIR is
    // set the default roots are not searched at all.
    return configured
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => path.resolve(entry))
  }
  return [path.join(home, '.kimi'), path.join(home, '.kimi-code')]
}

function isKimiWireFile(sessionsDir: string, filePath: string): boolean {
  if (path.basename(filePath) !== KIMI_WIRE_FILE) {
    return false
  }
  const relative = path.relative(sessionsDir, filePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false
  }
  return KIMI_WIRE_DEPTHS.has(relative.split(path.sep).filter(Boolean).length)
}

export async function kimiBackfillFiles(
  sourceRoot: string | undefined,
  home: string,
  env: AdapterEnv | undefined,
): Promise<BackfillSourceFile[]> {
  const roots = sourceRoot ? [path.resolve(sourceRoot)] : kimiDataDirs(home, env)
  const files: string[] = []
  for (const root of roots) {
    const sessionsDir = path.join(root, KIMI_SESSIONS_DIR)
    const candidates = await listFilesByExtensions(sessionsDir, ['.jsonl'])
    files.push(...candidates.filter(file => isKimiWireFile(sessionsDir, file)))
  }
  const unique = [...new Set(files)].sort()
  return Promise.all(unique.map(async (filePath) => {
    const info = await stat(filePath)
    return { path: filePath, modifiedAt: info.mtime.toISOString() }
  }))
}

// `<root>/sessions/<ws>/<session>/agents/<agent>/wire.jsonl` and the older
// `<root>/sessions/<group>/<session>/wire.jsonl` both put the session two or
// four levels above the file. Mirrors ccusage extract_session_id.
function kimiSessionIdFromPath(filePath: string): string {
  const agentDir = path.dirname(filePath)
  const sessionDir = path.basename(path.dirname(agentDir)) === 'agents'
    ? path.dirname(path.dirname(agentDir))
    : agentDir
  return path.basename(sessionDir)
}

// The kimi root holding config.json, walked back up from the wire file.
function kimiRootFromWirePath(filePath: string): string | undefined {
  const agentDir = path.dirname(filePath)
  const isNewLayout = path.basename(path.dirname(agentDir)) === 'agents'
  // new: root/sessions/<ws>/<session>/agents/<agent>/wire.jsonl
  // old: root/sessions/<group>/<session>/wire.jsonl
  const root = isNewLayout
    ? path.resolve(agentDir, '../../../../..')
    : path.resolve(agentDir, '../../..')
  return root || undefined
}

async function kimiConfiguredModel(filePath: string): Promise<string> {
  const root = kimiRootFromWirePath(filePath)
  if (!root) {
    return KIMI_DEFAULT_MODEL
  }
  try {
    const raw = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')) as unknown
    const model = stringField(raw as Record<string, unknown>, 'model')
    return model || KIMI_DEFAULT_MODEL
  }
  catch {
    return KIMI_DEFAULT_MODEL
  }
}

// ── Parser ──

/**
 * Token counts from either wire schema.
 *
 * The two schemas name the same four buckets differently — the new Kimi Code
 * format uses camelCase (`inputOther`, `inputCacheRead`, `inputCacheCreation`)
 * while the old StatusUpdate payload uses snake_case — but the meaning is
 * identical, so both funnel through here. `inputOther` is cache-EXCLUSIVE, as in
 * ccusage; codetime's tokensInput is cache-inclusive, so the cache buckets are
 * folded back in.
 */
function kimiUsageMetrics(
  usage: Record<string, unknown>,
  fields: { input: string, output: string, cacheCreation: string, cacheRead: string },
  explicitTotal = 0,
): Partial<MetricBag> | undefined {
  const input = numberField(usage, fields.input) || 0
  const output = numberField(usage, fields.output) || 0
  const cacheCreation = numberField(usage, fields.cacheCreation) || 0
  const cacheRead = numberField(usage, fields.cacheRead) || 0
  // ccusage apply_total_token_fallback: an explicit total can only ADD tokens the
  // parts do not account for (folded into billable output), never shrink the
  // parts sum.
  const partsSum = input + output + cacheCreation + cacheRead
  const missing = Math.max(0, explicitTotal - partsSum)
  const billableOutput = output + missing
  const totalTokens = partsSum + missing
  if (totalTokens <= 0) {
    return undefined
  }
  const cachedInput = cacheCreation + cacheRead
  return {
    tokensInput: (input + cachedInput) || undefined,
    tokensCachedInput: cachedInput || undefined,
    tokensCacheCreationInput: cacheCreation || undefined,
    tokensCacheReadInput: cacheRead || undefined,
    tokensOutput: billableOutput || undefined,
    tokensTotal: totalTokens,
    modelCalls: 1,
  }
}

interface KimiUsageLine {
  metrics: Partial<MetricBag>
  model: string
  ts: string | undefined
}

// New Kimi Code format: a top-level `usage.record` line.
function kimiUsageFromRecord(raw: Record<string, unknown>): KimiUsageLine | undefined {
  // Session-scoped records are cumulative totals of the turn records that
  // precede them — counting both would double the session.
  if (stringField(raw, 'usageScope') !== 'turn') {
    return undefined
  }
  const metrics = kimiUsageMetrics(objectField(raw, 'usage'), {
    input: 'inputOther',
    output: 'output',
    cacheCreation: 'inputCacheCreation',
    cacheRead: 'inputCacheRead',
  })
  if (!metrics) {
    return undefined
  }
  const model = stringField(raw, 'model')
  const time = numberField(raw, 'time')
  return {
    metrics,
    // Kimi Code prefixes the model with its provider route; the bare id is what
    // pricing catalogues carry.
    model: (model || KIMI_DEFAULT_MODEL).replace(/^kimi-code\//, ''),
    // `time` is epoch milliseconds here, unlike the old format's seconds.
    ts: time !== undefined && Number.isFinite(time) ? new Date(time).toISOString() : undefined,
  }
}

// Old format: `message.type === "StatusUpdate"` carrying `payload.token_usage`.
function kimiUsageFromStatusUpdate(
  raw: Record<string, unknown>,
  configuredModel: string,
): KimiUsageLine | undefined {
  const message = objectField(raw, 'message')
  if (stringField(message, 'type') !== 'StatusUpdate') {
    return undefined
  }
  const payload = objectField(message, 'payload')
  const tokenUsage = objectField(payload, 'token_usage')
  if (Object.keys(tokenUsage).length === 0) {
    return undefined
  }
  const metrics = kimiUsageMetrics(
    tokenUsage,
    { input: 'input_other', output: 'output', cacheCreation: 'input_cache_creation', cacheRead: 'input_cache_read' },
    numberField(tokenUsage, 'total') || 0,
  )
  if (!metrics) {
    return undefined
  }
  const seconds = numberField(raw, 'timestamp')
  return {
    metrics,
    // The old format names no model per line; config.json is the only source.
    model: configuredModel,
    ts: seconds !== undefined && Number.isFinite(seconds)
      ? new Date(Math.trunc(seconds * 1000)).toISOString()
      : undefined,
  }
}

async function parseKimiSessionFile(
  filePath: string,
  options: Record<string, unknown> & { _: string[] },
): Promise<CanonicalEvent[]> {
  const text = await readFile(filePath, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  if (lines.length === 0) {
    return []
  }

  const sourcePathHash = `sha256:${createStableHash(filePath)}`
  const sessionId = `kimi_${kimiSessionIdFromPath(filePath)}`
  const configuredModel = await kimiConfiguredModel(filePath)
  // A malformed or absent per-line timestamp degrades to the file's mtime rather
  // than dropping the line, mirroring ccusage's file_modified_timestamp.
  let fallbackTs: string
  try {
    const info = await stat(filePath)
    fallbackTs = info.mtime.toISOString()
  }
  catch {
    fallbackTs = new Date().toISOString()
  }

  const events: CanonicalEvent[] = []
  let sessionStarted = false

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const raw = parseJsonLine(line)
    if (!raw) {
      continue
    }
    const topType = stringField(raw, 'type')
    if (topType === 'metadata') {
      continue
    }
    const usage = topType === 'usage.record'
      ? kimiUsageFromRecord(raw)
      : kimiUsageFromStatusUpdate(raw, configuredModel)
    if (!usage) {
      continue
    }
    const ts = usage.ts || fallbackTs

    if (!sessionStarted) {
      sessionStarted = true
      events.push(withBackfillRefs(baseKimiEvent({
        ts,
        type: 'session.started',
        sessionId,
        model: usage.model,
        confidence: 'derived',
      }), { filePath, sourcePathHash, lineNumber, topType, payloadType: 'session', options }))
    }

    events.push(withBackfillRefs(baseKimiEvent({
      ts,
      type: 'model.usage',
      sessionId,
      model: usage.model,
      confidence: 'partial',
      metrics: usage.metrics,
    }), { filePath, sourcePathHash, lineNumber, topType, payloadType: 'usage', options }))
  }

  return events
}

function baseKimiEvent(
  event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId'>,
): CanonicalEvent {
  return {
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    source: 'kimi',
    agent: 'kimi',
    workspaceId: createWorkspaceId({ projectName: event.project, repoRoot: event.cwd }),
    ...event,
  }
}

// ── Adapter ──

export function createKimiAdapter(): AgentAdapter {
  return {
    id: 'kimi',
    label: 'Kimi Code',
    agentName: 'kimi',
    kind: 'agent',

    detectPath(home, env) {
      return kimiDataDirs(home, env)[0]
    },
    // Kimi exposes no plugin/hook surface, so there is nothing for codetime to
    // "install". Report installed = true whenever the sessions tree is on disk
    // so `detect` shows it as already covered via backfill (same as Amp).
    installedPath(home, env) {
      return path.join(kimiDataDirs(home, env)[0], KIMI_SESSIONS_DIR)
    },
    async isInstalled(home, env) {
      for (const root of kimiDataDirs(home, env)) {
        try {
          if (await pathExists(path.join(root, KIMI_SESSIONS_DIR))) {
            return true
          }
        }
        catch {
          continue
        }
      }
      return false
    },
    installEntries(): InstallEntry[] {
      return []
    },

    sourcePaths(home, env) {
      return kimiDataDirs(home, env).map(root => path.join(root, KIMI_SESSIONS_DIR))
    },

    parseSessionFile: parseKimiSessionFile,
  }
}
