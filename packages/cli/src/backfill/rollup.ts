import type { CanonicalEvent, SessionRollup } from '@codetime/shared'
import {
  createImportKey,
  createPayloadHash,
  createStableHash,
} from '@codetime/shared'
import { displayBackfillPath } from '../lib/activity.js'
import { ROLLUP_BUCKET_MS } from '../lib/constants.js'
import { estimateEventCostUsd } from '../lib/pricing.js'

export function buildSessionRollups(events: CanonicalEvent[]): SessionRollup[] {
  const grouped = new Map<string, CanonicalEvent[]>()
  for (const event of events) {
    const sourcePathHash = event.refs?.sourcePathHash || 'unknown'
    const sessionId = event.sessionId || `session_${createStableHash([event.source, sourcePathHash]).slice(0, 24)}`
    const key = createImportKey(['rollup', event.source, sourcePathHash, sessionId])
    const existing = grouped.get(key)
    if (existing) {
      existing.push(event)
    }
    else {
      grouped.set(key, [event])
    }
  }

  return [...grouped.entries()]
    .map(([rollupKey, sessionEvents]) => buildSessionRollup(rollupKey, sessionEvents))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

function buildSessionRollup(rollupKey: string, events: CanonicalEvent[]): SessionRollup {
  const ordered = [...events].sort((a, b) => a.ts.localeCompare(b.ts))
  const first = ordered[0]
  const sourcePathHash = first.refs?.sourcePathHash || 'unknown'
  const sessionId = first.sessionId || `session_${createStableHash([first.source, sourcePathHash]).slice(0, 24)}`
  const project = first.project || ordered.find(event => event.project)?.project
  const agent = first.agent || ordered.find(event => event.agent)?.agent
  const startedAt = ordered[0]?.ts || new Date().toISOString()
  const lastEventAt = ordered.at(-1)?.ts || startedAt
  const timeBuckets = new Map<string, SessionRollup['timeBuckets'][number]>()
  const modelRollups = new Map<string, SessionRollup['modelRollups'][number]>()
  const toolRollups = new Map<string, SessionRollup['toolRollups'][number]>()
  const fileRollups = new Map<string, SessionRollup['fileRollups'][number]>()
  const turnRollups = new Map<string, NonNullable<SessionRollup['turnRollups']>[number]>()

  let promptCount = 0
  let turnCount = 0
  let toolCallCount = 0
  let commandCallCount = 0
  let inputTokens = 0
  let cachedInputTokens = 0
  let cacheCreationInputTokens = 0
  let cacheReadInputTokens = 0
  let outputTokens = 0
  let reasoningOutputTokens = 0
  let totalTokens = 0
  let linesAdded = 0
  let linesRemoved = 0

  for (const event of ordered) {
    const eventInputTokens = Math.max(0, event.metrics?.tokensInput || 0)
    const eventCachedInputTokens = Math.max(0, event.metrics?.tokensCachedInput || 0)
    const eventCacheCreationInputTokens = Math.max(0, event.metrics?.tokensCacheCreationInput || 0)
    const eventCacheReadInputTokens = Math.max(0, event.metrics?.tokensCacheReadInput || 0)
    const eventOutputTokens = Math.max(0, event.metrics?.tokensOutput || 0)
    const eventReasoningOutputTokens = Math.max(0, event.metrics?.tokensReasoningOutput || 0)
    const eventTotalTokens = totalTokensFromEvent(event)
    const lineStats = lineStatsFromEvent(event)
    const eventCostUsd = estimateEventCostUsd(event)
    const bucketTs = floorRollupBucket(event.ts)
    const bucket = timeBuckets.get(bucketTs) || {
      ts: bucketTs,
      activityCount: 0,
      sessionStarts: 0,
      modelCalls: 0,
      toolCalls: 0,
      commandCalls: 0,
      fileReads: 0,
      fileWrites: 0,
      linesAdded: 0,
      linesRemoved: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    }

    if (event.type === 'prompt.submitted') {
      promptCount += 1
    }
    if (event.type === 'turn.started') {
      turnCount += 1
    }
    if (event.type === 'tool.started') {
      toolCallCount += 1
    }
    if (event.type === 'command.completed' || event.type === 'command.failed') {
      commandCallCount += 1
    }

    if (event.turnId) {
      const existing = turnRollups.get(event.turnId)
      const turnRollup = existing || {
        turnId: event.turnId,
        startedAt: event.ts,
        lastEventAt: event.ts,
        completedAt: undefined as string | undefined,
        promptSubmittedAt: undefined as string | undefined,
        promptChars: 0,
        eventCount: 0,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
      }
      if (event.type === 'prompt.submitted') {
        turnRollup.promptSubmittedAt = turnRollup.promptSubmittedAt || event.ts
        turnRollup.startedAt = turnRollup.promptSubmittedAt
        if (turnRollup.lastEventAt < turnRollup.startedAt) {
          turnRollup.lastEventAt = turnRollup.startedAt
        }
        turnRollup.promptChars += Math.max(0, event.metrics?.promptChars || 0)
      }
      else if (event.type === 'turn.completed') {
        turnRollup.completedAt = event.ts
      }
      else if (!existing) {
        turnRollup.startedAt = event.ts
      }
      else if (!turnRollup.promptSubmittedAt && event.ts < turnRollup.startedAt) {
        turnRollup.startedAt = event.ts
      }
      if (event.ts >= turnRollup.startedAt && event.ts > turnRollup.lastEventAt) {
        turnRollup.lastEventAt = event.ts
      }
      if (event.type === 'tool.started') {
        turnRollup.toolCallCount += 1
      }
      turnRollup.eventCount += 1
      turnRollup.inputTokens += eventInputTokens
      turnRollup.outputTokens += eventOutputTokens
      turnRollup.totalTokens += eventTotalTokens
      turnRollups.set(event.turnId, turnRollup)
    }

    inputTokens += eventInputTokens
    cachedInputTokens += eventCachedInputTokens
    cacheCreationInputTokens += eventCacheCreationInputTokens
    cacheReadInputTokens += eventCacheReadInputTokens
    outputTokens += eventOutputTokens
    reasoningOutputTokens += eventReasoningOutputTokens
    totalTokens += eventTotalTokens
    linesAdded += lineStats.linesAdded
    linesRemoved += lineStats.linesRemoved

    bucket.inputTokens += eventInputTokens
    bucket.cachedInputTokens += eventCachedInputTokens
    bucket.cacheCreationInputTokens += eventCacheCreationInputTokens
    bucket.cacheReadInputTokens += eventCacheReadInputTokens
    bucket.outputTokens += eventOutputTokens
    bucket.reasoningOutputTokens += eventReasoningOutputTokens
    bucket.totalTokens += eventTotalTokens
    bucket.linesAdded += lineStats.linesAdded
    bucket.linesRemoved += lineStats.linesRemoved
    bucket.estimatedCostUsd += eventCostUsd

    if (event.type === 'session.started') {
      bucket.sessionStarts += 1
      bucket.activityCount += 1
    }
    if (event.type === 'model.usage') {
      bucket.modelCalls += 1
      bucket.activityCount += 1
      const modelKey = event.model || 'unknown'
      const modelRollup = modelRollups.get(modelKey) || {
        model: modelKey,
        callCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      }
      modelRollup.callCount += 1
      modelRollup.inputTokens += eventInputTokens
      modelRollup.cachedInputTokens += eventCachedInputTokens
      modelRollup.cacheCreationInputTokens += eventCacheCreationInputTokens
      modelRollup.cacheReadInputTokens += eventCacheReadInputTokens
      modelRollup.outputTokens += eventOutputTokens
      modelRollup.reasoningOutputTokens += eventReasoningOutputTokens
      modelRollup.totalTokens += eventTotalTokens
      modelRollup.estimatedCostUsd += eventCostUsd
      modelRollups.set(modelKey, modelRollup)
    }
    if (event.type === 'tool.started') {
      bucket.toolCalls += 1
      bucket.activityCount += 1
      const toolKey = event.tool || 'tool'
      const toolRollup = toolRollups.get(toolKey) || {
        tool: toolKey,
        callCount: 0,
        failureCount: 0,
        totalDurationMs: 0,
      }
      toolRollup.callCount += 1
      toolRollups.set(toolKey, toolRollup)
    }
    if (event.type === 'tool.failed' || event.type === 'tool.completed') {
      const toolKey = event.tool || 'tool'
      const toolRollup = toolRollups.get(toolKey) || {
        tool: toolKey,
        callCount: 0,
        failureCount: 0,
        totalDurationMs: 0,
      }
      if (event.type === 'tool.failed') {
        toolRollup.failureCount += 1
      }
      toolRollup.totalDurationMs += eventDurationMs(event)
      toolRollups.set(toolKey, toolRollup)
    }
    if (event.type === 'command.completed' || event.type === 'command.failed') {
      bucket.commandCalls += 1
      bucket.activityCount += 1
    }

    for (const file of event.fileActivities || []) {
      const displayPath = displayBackfillPath(file.path)
      const pathHash = `sha256:${createStableHash(displayPath)}`
      const fileRollup = fileRollups.get(pathHash) || {
        pathHash,
        displayPath,
        reads: 0,
        writes: 0,
        linesAdded: 0,
        linesRemoved: 0,
        lastTouchedAt: file.ts || event.ts,
      }
      const fileLinesAdded = file.linesAdded || 0
      const fileLinesRemoved = file.linesRemoved || 0
      if (file.operation === 'read' || file.operation === 'search') {
        fileRollup.reads += 1
        bucket.fileReads += 1
        bucket.activityCount += 1
      }
      else {
        fileRollup.writes += 1
        bucket.fileWrites += 1
        bucket.activityCount += 1
      }
      fileRollup.linesAdded += fileLinesAdded
      fileRollup.linesRemoved += fileLinesRemoved
      if ((file.ts || event.ts) > fileRollup.lastTouchedAt) {
        fileRollup.lastTouchedAt = file.ts || event.ts
      }
      fileRollups.set(pathHash, fileRollup)
    }

    timeBuckets.set(bucketTs, bucket)
  }

  const baseRollup: SessionRollup = {
    rollupKey,
    payloadHash: '',
    source: first.source,
    project,
    sessionId,
    agent,
    startedAt,
    lastEventAt,
    eventCount: ordered.length,
    promptCount,
    turnCount,
    toolCallCount,
    commandCallCount,
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    linesAdded,
    linesRemoved,
    durationMs: Math.max(0, Date.parse(lastEventAt) - Date.parse(startedAt)),
    timeBuckets: [...timeBuckets.values()].sort((a, b) => a.ts.localeCompare(b.ts)),
    modelRollups: [...modelRollups.values()].sort((a, b) => b.callCount - a.callCount || a.model.localeCompare(b.model)),
    toolRollups: [...toolRollups.values()].sort((a, b) => b.callCount - a.callCount || a.tool.localeCompare(b.tool)),
    fileRollups: [...fileRollups.values()].sort((a, b) => b.writes - a.writes || b.reads - a.reads || a.displayPath.localeCompare(b.displayPath)),
    turnRollups: [...turnRollups.values()]
      .map(rollup => ({
        ...rollup,
        durationMs: Math.max(0, Date.parse(rollup.lastEventAt) - Date.parse(rollup.startedAt)),
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
  }

  return {
    ...baseRollup,
    payloadHash: createPayloadHash(baseRollup),
  }
}

function floorRollupBucket(ts: string): string {
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) {
    return ts
  }
  return new Date(Math.floor(ms / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS).toISOString()
}

function totalTokensFromEvent(event: CanonicalEvent): number {
  const explicit = event.metrics?.tokensTotal
  if (typeof explicit === 'number' && explicit > 0) {
    return explicit
  }
  return (
    Math.max(0, event.metrics?.tokensInput || 0)
    + Math.max(0, event.metrics?.tokensOutput || 0)
    + Math.max(0, event.metrics?.tokensReasoningOutput || 0)
  )
}

function lineStatsFromEvent(event: CanonicalEvent): { linesAdded: number, linesRemoved: number } {
  const files = event.fileActivities || []
  const fileLinesAdded = files.reduce((total, f) => total + (f.linesAdded || 0), 0)
  const fileLinesRemoved = files.reduce((total, f) => total + (f.linesRemoved || 0), 0)
  return {
    linesAdded: Math.max(fileLinesAdded, event.metrics?.linesAdded || 0),
    linesRemoved: Math.max(fileLinesRemoved, event.metrics?.linesRemoved || 0),
  }
}

function eventDurationMs(event: CanonicalEvent): number {
  return Math.max(
    0,
    event.metrics?.durationMs
      || event.metrics?.commandDurationMs
      || event.metrics?.toolDurationMs
      || event.metrics?.modelDurationMs
      || 0,
  )
}
