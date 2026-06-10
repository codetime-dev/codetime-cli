import { createHash } from 'node:crypto'

export const AGENT_TIME_API_VERSION = 'v1'
export const AGENT_TIME_SCHEMA_VERSION = '2026-04-29'

// Top-level SessionRollup schema version. Bumped to 2 when the CLI began emitting
// trustworthy gap-clamped turn durations and the billable-output token convention
// (tokensOutput includes reasoning tokens). The server uses this to decide how to
// treat the data: v1 rollups still get the legacy 15-min per-turn cap applied,
// while v2 rollups are trusted as-is. Older CLIs omit the field; the server reads
// a missing schemaVersion as 1.
export const AGENT_ROLLUP_SCHEMA_VERSION = 2

export const KNOWN_AGENT_SOURCES = [
  'codex',
  'claude-code',
  'opencode',
  'pi',
  'amp',
  'gemini',
  'generic-cli',
  'manual',
  'unknown',
] as const

export type KnownAgentSource = (typeof KNOWN_AGENT_SOURCES)[number]
export type AgentSource = KnownAgentSource | (string & {})
export type CaptureConfidence = 'exact' | 'partial' | 'derived' | 'estimated' | 'none'

export interface SourceCapabilities {
  sessionLifecycle: CaptureConfidence
  turnLifecycle: CaptureConfidence
  agentHierarchy: CaptureConfidence
  promptEvents: CaptureConfidence
  modelName: CaptureConfidence
  tokenUsage: CaptureConfidence
  toolCalls: CaptureConfidence
  toolTiming: CaptureConfidence
  commandTiming: CaptureConfidence
  fileReads: CaptureConfidence
  fileWrites: CaptureConfidence
  fileDiffStats: CaptureConfidence
  permissionEvents: CaptureConfidence
  transcriptLocator: CaptureConfidence
}

export const SOURCE_CAPABILITIES: Record<KnownAgentSource, SourceCapabilities> = {
  'codex': {
    sessionLifecycle: 'partial',
    turnLifecycle: 'partial',
    agentHierarchy: 'derived',
    promptEvents: 'partial',
    modelName: 'partial',
    tokenUsage: 'partial',
    toolCalls: 'partial',
    toolTiming: 'partial',
    commandTiming: 'exact',
    fileReads: 'derived',
    fileWrites: 'partial',
    fileDiffStats: 'partial',
    permissionEvents: 'partial',
    transcriptLocator: 'partial',
  },
  'claude-code': {
    sessionLifecycle: 'exact',
    turnLifecycle: 'partial',
    agentHierarchy: 'partial',
    promptEvents: 'partial',
    modelName: 'partial',
    tokenUsage: 'partial',
    toolCalls: 'exact',
    toolTiming: 'exact',
    commandTiming: 'exact',
    fileReads: 'partial',
    fileWrites: 'partial',
    fileDiffStats: 'partial',
    permissionEvents: 'exact',
    transcriptLocator: 'exact',
  },
  'opencode': {
    sessionLifecycle: 'partial',
    turnLifecycle: 'partial',
    agentHierarchy: 'partial',
    promptEvents: 'partial',
    modelName: 'partial',
    tokenUsage: 'partial',
    toolCalls: 'partial',
    toolTiming: 'partial',
    commandTiming: 'partial',
    fileReads: 'partial',
    fileWrites: 'partial',
    fileDiffStats: 'partial',
    permissionEvents: 'partial',
    transcriptLocator: 'partial',
  },
  'pi': {
    sessionLifecycle: 'partial',
    turnLifecycle: 'partial',
    agentHierarchy: 'none',
    promptEvents: 'partial',
    modelName: 'partial',
    tokenUsage: 'exact',
    toolCalls: 'partial',
    toolTiming: 'partial',
    commandTiming: 'partial',
    fileReads: 'partial',
    fileWrites: 'partial',
    fileDiffStats: 'partial',
    permissionEvents: 'none',
    transcriptLocator: 'exact',
  },
  // Amp keeps a per-thread JSON with a ledger of usage events; only token
  // accounting is exposed locally, no tool/file/cwd telemetry.
  'amp': {
    sessionLifecycle: 'derived',
    turnLifecycle: 'none',
    agentHierarchy: 'none',
    promptEvents: 'none',
    modelName: 'exact',
    tokenUsage: 'exact',
    toolCalls: 'none',
    toolTiming: 'none',
    commandTiming: 'none',
    fileReads: 'none',
    fileWrites: 'none',
    fileDiffStats: 'none',
    permissionEvents: 'none',
    transcriptLocator: 'exact',
  },
  // Gemini CLI writes per-session JSON/JSONL logs under ~/.gemini/tmp with token
  // counts only; no tool/file/cwd telemetry, so timing is derived from message
  // timestamps and everything else is absent.
  'gemini': {
    sessionLifecycle: 'derived',
    turnLifecycle: 'none',
    agentHierarchy: 'none',
    promptEvents: 'none',
    modelName: 'partial',
    tokenUsage: 'exact',
    toolCalls: 'none',
    toolTiming: 'none',
    commandTiming: 'none',
    fileReads: 'none',
    fileWrites: 'none',
    fileDiffStats: 'none',
    permissionEvents: 'none',
    transcriptLocator: 'exact',
  },
  'generic-cli': {
    sessionLifecycle: 'estimated',
    turnLifecycle: 'estimated',
    agentHierarchy: 'none',
    promptEvents: 'estimated',
    modelName: 'none',
    tokenUsage: 'none',
    toolCalls: 'partial',
    toolTiming: 'estimated',
    commandTiming: 'partial',
    fileReads: 'none',
    fileWrites: 'partial',
    fileDiffStats: 'partial',
    permissionEvents: 'none',
    transcriptLocator: 'none',
  },
  'manual': {
    sessionLifecycle: 'estimated',
    turnLifecycle: 'estimated',
    agentHierarchy: 'none',
    promptEvents: 'estimated',
    modelName: 'none',
    tokenUsage: 'none',
    toolCalls: 'none',
    toolTiming: 'none',
    commandTiming: 'none',
    fileReads: 'none',
    fileWrites: 'none',
    fileDiffStats: 'none',
    permissionEvents: 'none',
    transcriptLocator: 'none',
  },
  'unknown': {
    sessionLifecycle: 'none',
    turnLifecycle: 'none',
    agentHierarchy: 'none',
    promptEvents: 'none',
    modelName: 'none',
    tokenUsage: 'none',
    toolCalls: 'none',
    toolTiming: 'none',
    commandTiming: 'none',
    fileReads: 'none',
    fileWrites: 'none',
    fileDiffStats: 'none',
    permissionEvents: 'none',
    transcriptLocator: 'none',
  },
}

export const TELEMETRY_EVENT_TYPES = [
  'session.started',
  'session.ended',
  'session.status_changed',
  'agent.started',
  'agent.ended',
  'subagent.started',
  'subagent.ended',
  'turn.started',
  'prompt.submitted',
  'turn.completed',
  'turn.failed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'file.read',
  'file.searched',
  'file.changed',
  'command.started',
  'command.completed',
  'command.failed',
  'model.usage',
  'permission.requested',
  'permission.resolved',
  'context.compacted',
  'test.completed',
  'git.changed',
  'agent.operation',
] as const

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number]

export const FILE_ACTIVITY_OPERATIONS = ['read', 'search', 'create', 'write', 'edit', 'delete'] as const
export type FileActivityOperation = (typeof FILE_ACTIVITY_OPERATIONS)[number]

export interface MetricBag {
  durationMs?: number
  wallTimeMs?: number
  agentActiveMs?: number
  userWaitMs?: number
  approvalWaitMs?: number
  modelDurationMs?: number
  toolDurationMs?: number
  commandDurationMs?: number
  // tokensInput is cache-inclusive (it includes cached/cache-read input tokens).
  tokensInput?: number
  // tokensOutput is the billable output total and INCLUDES reasoning tokens. For
  // sources that report reasoning separately (Gemini thoughts, OpenCode/Codex
  // headless reasoning_output_tokens), adapters fold reasoning into tokensOutput
  // so downstream cost math never double-counts it.
  tokensOutput?: number
  tokensCachedInput?: number
  tokensCacheCreationInput?: number
  tokensCacheReadInput?: number
  // tokensReasoningOutput is an informational subset of tokensOutput. It is NOT
  // added on top of tokensOutput for billing/total purposes — it only exposes how
  // much of the billable output was reasoning.
  tokensReasoningOutput?: number
  // tokensTotal prefers an explicit upstream total; otherwise it is
  // tokensInput + tokensOutput (reasoning already folded into tokensOutput).
  tokensTotal?: number
  modelContextWindow?: number
  promptChars?: number
  agentMessageChars?: number
  costUsd?: number
  toolCalls?: number
  commandCalls?: number
  modelCalls?: number
  prompts?: number
  turns?: number
  filesRead?: number
  filesChanged?: number
  bytesRead?: number
  bytesWritten?: number
  charsRead?: number
  charsWritten?: number
  linesRead?: number
  linesAdded?: number
  linesRemoved?: number
}

export interface FileActivityRecord {
  fileActivityId?: string
  workspaceId?: string
  sessionId?: string
  turnId?: string
  agentInstanceId?: string
  spanId?: string
  ts: string
  path: string
  operation: FileActivityOperation
  language?: string
  fileKind?: 'source' | 'test' | 'config' | 'docs' | 'data' | 'unknown'
  bytesRead?: number
  bytesWritten?: number
  charsRead?: number
  charsWritten?: number
  linesRead?: number
  linesAdded?: number
  linesRemoved?: number
  confidence?: CaptureConfidence
}

export interface CanonicalEvent {
  id?: string
  schemaVersion: string
  ts: string
  type: TelemetryEventType
  source: AgentSource
  workspaceId?: string
  project?: string
  cwd?: string
  sessionId?: string
  agentInstanceId?: string
  parentAgentInstanceId?: string
  turnId?: string
  spanId?: string
  parentSpanId?: string
  agent?: string
  operation?: string
  tool?: string
  model?: string
  success?: boolean
  confidence?: CaptureConfidence
  metrics?: MetricBag
  fileActivities?: FileActivityRecord[]
  refs?: Record<string, string>
}

export interface StoredCanonicalEvent extends CanonicalEvent {
  id: string
  receivedAt: string
}

export const BACKFILL_SOURCE_IDS = ['codex', 'claude-code', 'opencode', 'pi', 'amp', 'gemini'] as const
export type BackfillSourceId = typeof BACKFILL_SOURCE_IDS[number]
export type ImportRunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ImportRunRecord {
  importRunId: string
  source: BackfillSourceId | 'all'
  status: ImportRunStatus
  startedAt: string
  endedAt?: string
  parserVersion: string
  schemaVersion: string
  dryRun: boolean
  filters: {
    since?: string
    until?: string
    project?: string
    sourceRoot?: string
  }
  counts: {
    discovered: number
    planned: number
    inserted: number
    skipped: number
    conflicts: number
    failed: number
  }
}

export interface BackfillCandidate {
  source: BackfillSourceId
  label: string
  exists: boolean
  entries: number
  pathHash: string
  path?: string
}

export interface BackfillPlannedEvent {
  source: BackfillSourceId
  importKey: string
  eventId: string
  payloadHash: string
  type: TelemetryEventType
  confidence: CaptureConfidence
}

export interface BackfillPlan {
  importRun: ImportRunRecord
  candidates: BackfillCandidate[]
  plannedEvents: BackfillPlannedEvent[]
  privacy: string
}

export interface SessionTimeBucketRollup {
  ts: string
  activityCount: number
  sessionStarts: number
  modelCalls: number
  toolCalls: number
  commandCalls: number
  fileReads: number
  fileWrites: number
  linesAdded: number
  linesRemoved: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

export interface SessionModelRollup {
  model: string
  callCount: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

export interface SessionToolRollup {
  tool: string
  callCount: number
  failureCount: number
  totalDurationMs: number
}

export interface SessionFileRollup {
  pathHash: string
  displayPath: string
  reads: number
  writes: number
  linesAdded: number
  linesRemoved: number
  lastTouchedAt: string
}

export interface SessionTurnRollup {
  turnId: string
  startedAt: string
  lastEventAt: string
  completedAt?: string
  promptSubmittedAt?: string
  promptChars: number
  eventCount: number
  toolCallCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs: number
}

export interface SessionRollup {
  rollupKey: string
  payloadHash: string
  // Rollup schema version (see AGENT_ROLLUP_SCHEMA_VERSION). Optional so the type
  // still describes rollups produced by older CLIs, which omit it (server treats
  // a missing value as 1).
  schemaVersion?: number
  source: AgentSource
  project?: string
  sessionId: string
  agent?: string
  startedAt: string
  lastEventAt: string
  eventCount: number
  promptCount: number
  turnCount: number
  toolCallCount: number
  commandCallCount: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  linesAdded: number
  linesRemoved: number
  durationMs: number
  timeBuckets: SessionTimeBucketRollup[]
  modelRollups: SessionModelRollup[]
  toolRollups: SessionToolRollup[]
  fileRollups: SessionFileRollup[]
  turnRollups?: SessionTurnRollup[]
}

export interface TelemetrySummary {
  totalEvents: number
  totalSessions: number
  totalProjects: number
  totalDurationMs: number
  totalFilesRead: number
  totalFilesTouched: number
  totalLinesAdded: number
  totalLinesRemoved: number
  byType: Record<string, number>
  bySource: Record<string, number>
  byAgent: Record<string, number>
}

export interface ProjectSummary {
  project: string
  events: number
  sessions: number
  latestAt: string
}

export interface SessionSummary {
  sessionId: string
  agent: string
  project?: string
  events: number
  startedAt: string
  latestAt: string
  latestTurnStartedAt?: string
  latestTurnCompletedAt?: string
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function getSourceCapabilities(source: AgentSource): SourceCapabilities {
  const known = KNOWN_AGENT_SOURCES.includes(source as KnownAgentSource) ? (source as KnownAgentSource) : 'unknown'
  return { ...SOURCE_CAPABILITIES[known] }
}

export function durationMs(startedAt?: string, endedAt?: string): number | undefined {
  if (!startedAt || !endedAt) {
    return undefined
  }

  const started = Date.parse(startedAt)
  const ended = Date.parse(endedAt)
  if (Number.isNaN(started) || Number.isNaN(ended)) {
    return undefined
  }

  return Math.max(0, ended - started)
}

export function createWorkspaceId(input: { projectName?: string, repoRoot?: string, repoUrl?: string }): string {
  const basis = input.repoUrl || input.repoRoot || input.projectName || 'unknown'
  return `workspace_${fnv1a(basis)}`
}

export function createImportKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts
    .filter(part => part !== undefined && part !== null && part !== '')
    .map(part => encodeURIComponent(String(part)))
    .join(':')
}

export function createStableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function createStableEventId(importKey: string): string {
  return `evt_${createStableHash(importKey).slice(0, 24)}`
}

export function createPayloadHash(value: unknown): string {
  return `sha256:${createStableHash(removeVolatileHashFields(value))}`
}

export function normalizeCanonicalEvent(input: CanonicalEvent): CanonicalEvent {
  return {
    ...input,
    schemaVersion: input.schemaVersion || AGENT_TIME_SCHEMA_VERSION,
    ts: input.ts || new Date().toISOString(),
    source: input.source || 'unknown',
    type: input.type || 'agent.operation',
    fileActivities: input.fileActivities?.filter(file => file.path),
  }
}

export function isTelemetryEventType(value: unknown): value is TelemetryEventType {
  return typeof value === 'string' && TELEMETRY_EVENT_TYPES.includes(value as TelemetryEventType)
}

export function isFileActivityOperation(value: unknown): value is FileActivityOperation {
  return typeof value === 'string' && FILE_ACTIVITY_OPERATIONS.includes(value as FileActivityOperation)
}

export function validateCanonicalEvent(input: unknown): ValidationResult {
  const errors: string[] = []

  if (!isRecord(input)) {
    return { valid: false, errors: ['Event must be an object'] }
  }

  requireString(input, 'source', errors)
  if (!isTelemetryEventType(input.type)) {
    errors.push('type must be a supported telemetry event type')
  }

  optionalString(input, 'schemaVersion', errors)
  optionalString(input, 'ts', errors)
  optionalString(input, 'workspaceId', errors)
  optionalString(input, 'project', errors)
  optionalString(input, 'cwd', errors)
  optionalString(input, 'sessionId', errors)
  optionalString(input, 'agentInstanceId', errors)
  optionalString(input, 'parentAgentInstanceId', errors)
  optionalString(input, 'turnId', errors)
  optionalString(input, 'spanId', errors)
  optionalString(input, 'parentSpanId', errors)
  optionalString(input, 'agent', errors)
  optionalString(input, 'operation', errors)
  optionalString(input, 'tool', errors)
  optionalString(input, 'model', errors)

  if (input.success !== undefined && typeof input.success !== 'boolean') {
    errors.push('success must be a boolean when present')
  }

  if (input.metrics !== undefined) {
    validateMetricBag(input.metrics, errors, 'metrics')
  }
  if (input.fileActivities !== undefined) {
    validateFileActivities(input.fileActivities, errors)
  }

  return { valid: errors.length === 0, errors }
}

export function summarizeCanonicalEvents(events: StoredCanonicalEvent[]): TelemetrySummary {
  const sessionIds = new Set<string>()
  const projects = new Set<string>()
  const byType: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  const byAgent: Record<string, number> = {}
  let totalFilesRead = 0
  let totalFilesTouched = 0
  let totalLinesAdded = 0
  let totalLinesRemoved = 0
  let totalDurationMs = 0

  for (const event of events) {
    if (event.sessionId) {
      sessionIds.add(event.sessionId)
    }
    if (event.project) {
      projects.add(event.project)
    }
    byType[event.type] = (byType[event.type] || 0) + 1
    bySource[event.source] = (bySource[event.source] || 0) + 1
    if (event.agent) {
      byAgent[event.agent] = (byAgent[event.agent] || 0) + 1
    }

    const fileActivities = event.fileActivities || []
    let fileLinesAdded = 0
    let fileLinesRemoved = 0
    for (const file of fileActivities) {
      if (file.operation === 'read' || file.operation === 'search') {
        totalFilesRead += 1
      }
      if (file.operation === 'create' || file.operation === 'write' || file.operation === 'edit' || file.operation === 'delete') {
        totalFilesTouched += 1
      }
      fileLinesAdded += file.linesAdded || 0
      fileLinesRemoved += file.linesRemoved || 0
    }

    totalLinesAdded += Math.max(fileLinesAdded, event.metrics?.linesAdded || 0)
    totalLinesRemoved += Math.max(fileLinesRemoved, event.metrics?.linesRemoved || 0)

    totalDurationMs += event.metrics?.agentActiveMs || 0
    totalDurationMs += event.metrics?.modelDurationMs || 0
    totalDurationMs += event.metrics?.toolDurationMs || 0
    totalDurationMs += event.metrics?.commandDurationMs || 0
  }

  return {
    totalEvents: events.length,
    totalSessions: sessionIds.size,
    totalProjects: projects.size,
    totalFilesRead,
    totalFilesTouched,
    totalLinesAdded,
    totalLinesRemoved,
    totalDurationMs,
    byType,
    bySource,
    byAgent,
  }
}

export function formatModelName(model: string): string {
  const name = model.includes('/') ? model.split('/').pop()! : model

  const special: Record<string, string> = {
    gpt: 'GPT',
    claude: 'Claude',
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
    deepseek: 'DeepSeek',
    codex: 'Codex',
    gemini: 'Gemini',
    nova: 'Nova',
    llama: 'LLaMA',
    qwen: 'Qwen',
    mistral: 'Mistral',
    codestral: 'Codestral',
    glm: 'GLM',
  }

  return name.split('-').map((part) => {
    const lower = part.toLowerCase()
    if (special[lower]) {
      return special[lower]
    }
    if (/^v\d/.test(lower)) {
      return `V${part.slice(1)}`
    }
    if (/^\d{4,}$/.test(lower)) {
      return part
    }
    if (/^[\d.]+$/.test(lower)) {
      return part
    }
    return part.charAt(0).toUpperCase() + part.slice(1)
  }).join(' ')
}

function fnv1a(value: string): string {
  let hash = 0x81_1C_9D_C5

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01_00_01_93)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

function validateFileActivities(value: unknown, errors: string[]) {
  if (!Array.isArray(value)) {
    errors.push('fileActivities must be an array when present')
    return
  }

  for (const [index, item] of value.entries()) {
    const prefix = `fileActivities[${index}]`
    if (!isRecord(item)) {
      errors.push(`${prefix} must be an object`)
      continue
    }

    requireString(item, 'ts', errors, prefix)
    requireString(item, 'path', errors, prefix)
    if (!isFileActivityOperation(item.operation)) {
      errors.push(`${prefix}.operation must be a supported file activity operation`)
    }

    validateOptionalNumber(item, 'bytesRead', errors, prefix)
    validateOptionalNumber(item, 'bytesWritten', errors, prefix)
    validateOptionalNumber(item, 'charsRead', errors, prefix)
    validateOptionalNumber(item, 'charsWritten', errors, prefix)
    validateOptionalNumber(item, 'linesRead', errors, prefix)
    validateOptionalNumber(item, 'linesAdded', errors, prefix)
    validateOptionalNumber(item, 'linesRemoved', errors, prefix)
  }
}

function validateMetricBag(value: unknown, errors: string[], prefix: string) {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object when present`)
    return
  }

  for (const key of Object.keys(value)) {
    const metric = value[key]
    if (metric !== undefined && (typeof metric !== 'number' || !Number.isFinite(metric))) {
      errors.push(`${prefix}.${key} must be a finite number`)
    }
  }
}

function requireString(object: Record<string, unknown>, key: string, errors: string[], prefix?: string) {
  const value = object[key]
  const field = prefix ? `${prefix}.${key}` : key
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${field} must be a non-empty string`)
  }
}

function optionalString(object: Record<string, unknown>, key: string, errors: string[]) {
  const value = object[key]
  if (value !== undefined && typeof value !== 'string') {
    errors.push(`${key} must be a string when present`)
  }
}

function validateOptionalNumber(object: Record<string, unknown>, key: string, errors: string[], prefix: string) {
  const value = object[key]
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    errors.push(`${prefix}.${key} must be a finite number`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }

  const object = value as Record<string, unknown>
  const entries = Object.keys(object)
    .filter(key => object[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
  return `{${entries.join(',')}}`
}

function removeVolatileHashFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => removeVolatileHashFields(item))
  }
  if (!isRecord(value)) {
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'receivedAt') {
      continue
    }
    if (key === 'refs' && isRecord(item)) {
      const refs = { ...item }
      delete refs.payloadHash
      result[key] = removeVolatileHashFields(refs)
      continue
    }
    result[key] = removeVolatileHashFields(item)
  }
  return result
}
