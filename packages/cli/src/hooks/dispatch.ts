import type { AgentSource, CanonicalEvent, FileActivityRecord, MetricBag, TelemetryEventType } from '@codetime/shared'
import { open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createStableHash,
  createWorkspaceId,
} from '@codetime/shared'
import {
  addPathActivity,
  eventTypeFromFileActivities,
  mergeFileActivity,
  summarizeFileActivities,
} from '../lib/activity.js'
import { parseApplyPatch, patchFromCommand } from '../lib/diff.js'
import {
  isPlainObject,
  numberField,
  objectField,
  stringField,
  stringOption,
  stringRefs,
} from '../lib/fields.js'
import { durationObjectToMs } from '../lib/jsonl.js'
import { estimateEventCostUsd } from '../lib/pricing.js'

export interface HookEnrichment {
  model?: string
  lastUsage?: Partial<MetricBag>
  lastUsageMessageId?: string
  turnUsage?: Partial<MetricBag> & { modelCalls?: number }
}

const TRANSCRIPT_TAIL_BYTES = 512 * 1024

export function hookEventsFromPayload(
  agent: string,
  payload: Record<string, unknown>,
  options: Record<string, unknown>,
  enrichment: HookEnrichment = {},
  adapters?: {
    tokenUsageFromPayload?: (payload: Record<string, unknown>) => Partial<MetricBag> | undefined
  },
): CanonicalEvent[] {
  const eventName = stringField(payload, 'hook_event_name') || 'agent.operation'
  const tool = stringField(payload, 'tool_name')
  const cwd = stringField(payload, 'cwd')
  const model = stringField(payload, 'model') || enrichment.model
  const project = stringOption(options.project) || (cwd ? path.basename(cwd) : undefined)
  const source = toAgentSource(agent)
  const ts = new Date().toISOString()
  const toolUseId = stringField(payload, 'tool_use_id') || stringField(payload, 'toolUseId')
  const turnId = stringField(payload, 'turn_id') || stringField(payload, 'turnId')
  const sessionId = stringField(payload, 'session_id') || stringField(payload, 'sessionId')
  const prompt = stringField(payload, 'prompt')
  const fileActivities = extractFileActivities(payload, tool, ts)
  const lineMetrics = summarizeFileActivities(fileActivities)
  const durationMs = numberField(payload, 'duration_ms') || durationObjectToMs(objectField(payload, 'duration'))
  const command = stringField(objectField(payload, 'tool_input'), 'command')
  const commandHash = tool === 'Bash' && command
    ? createStableHash(command)
    : undefined
  const codexUsage = adapters?.tokenUsageFromPayload?.(payload)
  const baseEvent = (type: TelemetryEventType, extra: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    ts,
    source,
    agent,
    type,
    project,
    cwd,
    workspaceId: createWorkspaceId({ projectName: project, repoRoot: cwd }),
    sessionId,
    turnId,
    tool,
    model,
    ...extra,
  })
  const usageEvent = (
    metrics: Record<string, number | undefined>,
    extra: { messageId?: string, confidence?: CanonicalEvent['confidence'] } = {},
  ): CanonicalEvent | undefined => {
    const total = (metrics.tokensInput || 0) + (metrics.tokensOutput || 0) + (metrics.tokensReasoningOutput || 0)
    if (total <= 0) {
      return undefined
    }
    const finalMetrics: MetricBag = {
      ...metrics,
      tokensTotal: metrics.tokensTotal || total,
    }
    const eventBase = baseEvent('model.usage', {
      operation: 'model usage',
      confidence: extra.confidence ?? 'partial',
      metrics: finalMetrics,
      refs: stringRefs({
        sourceId: extra.messageId,
        messageId: extra.messageId,
      }),
    })
    const cost = estimateEventCostUsd(eventBase)
    if (cost > 0) {
      eventBase.metrics = { ...finalMetrics, costUsd: cost }
    }
    return eventBase
  }

  switch (eventName) {
    case 'SessionStart': {
      return [baseEvent('session.started', { operation: stringField(payload, 'source') || 'session start' })]
    }
    case 'SessionEnd': {
      return [baseEvent('session.ended', { operation: stringField(payload, 'reason') || 'session end' })]
    }
    case 'UserPromptSubmit': {
      return [
        baseEvent('prompt.submitted', {
          operation: 'prompt submitted',
          metrics: { prompts: 1, promptChars: prompt?.length },
          refs: stringRefs({
            promptHash: prompt ? `sha256:${createStableHash(prompt)}` : undefined,
          }),
        }),
      ]
    }
    case 'PreToolUse': {
      return [
        baseEvent('tool.started', {
          operation: tool ? `${tool} started` : eventName,
          metrics: { toolCalls: 1 },
          refs: stringRefs({ sourceId: toolUseId, commandHash }),
        }),
      ]
    }
    case 'PermissionRequest': {
      return [
        baseEvent('permission.requested', {
          operation: tool ? `${tool} permission requested` : 'permission requested',
          refs: stringRefs({ sourceId: toolUseId, commandHash }),
        }),
      ]
    }
    case 'PermissionDenied': {
      return [
        baseEvent('permission.resolved', {
          operation: tool ? `${tool} permission denied` : 'permission denied',
          success: false,
          refs: stringRefs({ sourceId: toolUseId, commandHash }),
        }),
      ]
    }
    case 'PostToolUse': {
      const events = buildHookToolResultEvents({
        baseEvent,
        tool,
        toolUseId,
        commandHash,
        durationMs,
        success: true,
        fileActivities,
        lineMetrics,
      })
      if (codexUsage) {
        const usage = usageEvent({
          ...codexUsage,
          modelCalls: 1,
          modelDurationMs: durationMs,
        }, { confidence: 'exact' })
        if (usage) {
          events.push(usage)
        }
      }
      return events
    }
    case 'PostToolUseFailure': {
      return buildHookToolResultEvents({
        baseEvent,
        tool,
        toolUseId,
        commandHash,
        durationMs,
        success: false,
        fileActivities,
        lineMetrics,
        error: stringField(payload, 'error'),
      })
    }
    case 'SubagentStart': {
      return [
        baseEvent('subagent.started', {
          operation: 'subagent started',
          agentInstanceId: stringField(payload, 'agent_id') || stringField(payload, 'agentId'),
        }),
      ]
    }
    case 'SubagentStop': {
      return [
        baseEvent('subagent.ended', {
          operation: 'subagent completed',
          agentInstanceId: stringField(payload, 'agent_id') || stringField(payload, 'agentId'),
          success: !payload.error,
        }),
      ]
    }
    case 'Stop': {
      const turnUsage = enrichment.turnUsage || codexUsage
      const turnMetrics: MetricBag = { durationMs }
      if (turnUsage) {
        Object.assign(turnMetrics, turnUsage)
        if (!turnMetrics.modelCalls && enrichment.turnUsage?.modelCalls) {
          turnMetrics.modelCalls = enrichment.turnUsage.modelCalls
        }
      }
      const events: CanonicalEvent[] = [
        baseEvent('turn.completed', { operation: 'turn completed', metrics: turnMetrics }),
      ]
      if (turnUsage) {
        const usage = usageEvent(
          { ...turnUsage, modelCalls: turnMetrics.modelCalls, modelDurationMs: durationMs },
          { messageId: enrichment.lastUsageMessageId, confidence: enrichment.turnUsage ? 'derived' : 'exact' },
        )
        if (usage) {
          events.push(usage)
        }
      }
      return events
    }
    case 'StopFailure': {
      return [baseEvent('turn.failed', { operation: 'turn failed' })]
    }
    case 'PostCompact': {
      return [baseEvent('context.compacted', { operation: 'context compacted' })]
    }
    default: {
      return []
    }
  }
}

export async function enrichFromTranscript(
  payload: Record<string, unknown>,
  claudeUsageFromMessage?: (message: Record<string, unknown>) => Partial<MetricBag> | undefined,
): Promise<HookEnrichment> {
  const transcriptPath = stringField(payload, 'transcript_path')
  if (!transcriptPath) {
    return {}
  }
  let text: string
  try {
    const stats = await stat(transcriptPath)
    if (stats.size <= TRANSCRIPT_TAIL_BYTES) {
      text = await readFile(transcriptPath, 'utf8')
    }
    else {
      const handle = await open(transcriptPath, 'r')
      try {
        const buffer = Buffer.alloc(TRANSCRIPT_TAIL_BYTES)
        await handle.read(buffer, 0, TRANSCRIPT_TAIL_BYTES, stats.size - TRANSCRIPT_TAIL_BYTES)
        text = buffer.toString('utf8')
        const newlineIndex = text.indexOf('\n')
        if (newlineIndex !== -1) {
          text = text.slice(newlineIndex + 1)
        }
      }
      finally {
        await handle.close()
      }
    }
  }
  catch (error) {
    if (process.env.CODETIME_DEBUG || process.env.AGENT_TIME_DEBUG) {
      process.stderr.write(`[codetime] enrichFromTranscript: failed to read transcript ${transcriptPath}: ${(error as Error).message}\n`)
    }
    return {}
  }
  const lines = text.split('\n')
  let model: string | undefined
  let lastUsage: Partial<MetricBag> | undefined
  let lastUsageMessageId: string | undefined
  const turnUsage: Record<string, number> = {}
  let turnCalls = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const raw = lines[index]
    if (!raw) {
      continue
    }
    let entry: unknown
    try {
      entry = JSON.parse(raw)
    }
    catch {
      continue
    }
    if (!isPlainObject(entry)) {
      continue
    }
    const topType = stringField(entry, 'type')
    const message = objectField(entry, 'message')
    if (topType === 'user') {
      if (Object.keys(message).length > 0 && isClaudeToolResultMessage(message)) {
        continue
      }
      break
    }
    if (topType !== 'assistant') {
      continue
    }
    if (!model) {
      model = stringField(message, 'model')
    }
    if (!claudeUsageFromMessage) {
      continue
    }
    const usage = claudeUsageFromMessage(message)
    if (!usage) {
      continue
    }
    if (!lastUsage) {
      lastUsage = usage
      lastUsageMessageId = stringField(message, 'id')
    }
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === 'number') {
        turnUsage[key] = (turnUsage[key] || 0) + value
      }
    }
    turnCalls += 1
  }
  return {
    model,
    lastUsage,
    lastUsageMessageId,
    turnUsage: turnCalls > 0 ? { ...(turnUsage as Partial<MetricBag>), modelCalls: turnCalls } : undefined,
  }
}

function isClaudeToolResultMessage(message: Record<string, unknown>): boolean {
  return (Array.isArray(message.content)
    ? message.content.some(
        (item: unknown) => isPlainObject(item) && item.type === 'tool_result',
      )
    : false)
}

function extractFileActivities(
  payload: Record<string, unknown>,
  tool: string | undefined,
  ts: string,
): FileActivityRecord[] {
  const changes = new Map<string, FileActivityRecord>()
  const toolInput = objectField(payload, 'tool_input')
  const toolResponse = objectField(payload, 'tool_response')
  const operation = operationForTool(tool)

  addPathActivity(changes, stringField(toolInput, 'file_path') || stringField(toolInput, 'path'), operation, ts)
  addPathActivity(changes, stringField(toolResponse, 'filePath') || stringField(toolResponse, 'file_path'), operation, ts)

  for (const file of arrayField(toolInput, 'files')) {
    if (typeof file === 'string') {
      addPathActivity(changes, file, operation, ts)
    }
  }

  const patch = stringField(toolInput, 'patch') || patchFromCommand(stringField(toolInput, 'command'))
  if (patch) {
    for (const change of parseApplyPatch(patch, ts)) {
      const current = changes.get(change.path)
      changes.set(change.path, mergeFileActivity(current, change))
    }
  }

  return [...changes.values()]
}

function operationForTool(tool: string | undefined): FileActivityRecord['operation'] {
  const normalized = (tool || '').toLowerCase()
  if (['read', 'notebookread', 'view_image'].includes(normalized)) {
    return 'read'
  }
  if (['grep', 'glob', 'ls', 'search', 'rg'].includes(normalized)) {
    return 'search'
  }
  if (['write'].includes(normalized)) {
    return 'write'
  }
  if (['edit', 'multiedit', 'notebookedit', 'apply_patch', 'applypatch'].includes(normalized)) {
    return 'edit'
  }
  return 'read'
}

function arrayField(object: unknown, key: string): unknown[] {
  if (!isPlainObject(object) || !Array.isArray(object[key])) {
    return []
  }
  return object[key] as unknown[]
}

function buildHookToolResultEvents(input: {
  baseEvent: (type: TelemetryEventType, extra?: Partial<CanonicalEvent>) => CanonicalEvent
  tool: string | undefined
  toolUseId: string | undefined
  commandHash: string | undefined
  durationMs: number | undefined
  success: boolean
  fileActivities: FileActivityRecord[]
  lineMetrics: { linesAdded?: number, linesRemoved?: number }
  error?: string
}): CanonicalEvent[] {
  const refs = stringRefs({
    sourceId: input.toolUseId,
    commandHash: input.commandHash,
  })
  const events: CanonicalEvent[] = [
    input.baseEvent(input.success ? 'tool.completed' : 'tool.failed', {
      operation: input.tool ? `${input.tool} completed` : 'tool completed',
      success: input.success,
      metrics: {
        toolDurationMs: input.durationMs,
        durationMs: input.durationMs,
      },
      refs,
    }),
  ]

  if (input.tool === 'Bash') {
    events.push(input.baseEvent(input.success ? 'command.completed' : 'command.failed', {
      operation: 'command completed',
      success: input.success,
      metrics: {
        commandCalls: 1,
        commandDurationMs: input.durationMs,
        durationMs: input.durationMs,
      },
      refs,
    }))
  }

  if (input.fileActivities.length > 0) {
    events.push(input.baseEvent(eventTypeFromFileActivities(input.fileActivities), {
      operation: input.tool ? `${input.tool} file activity` : 'file activity',
      success: input.success,
      fileActivities: input.fileActivities,
      metrics: input.lineMetrics,
      refs,
    }))
  }

  return events
}

function toAgentSource(agent: string): AgentSource {
  if (agent === 'claude') {
    return 'claude-code'
  }
  if (agent === 'codex' || agent === 'cursor' || agent === 'opencode') {
    return agent
  }
  return agent || 'unknown'
}
