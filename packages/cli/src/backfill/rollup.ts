import type { CanonicalEvent, SessionRollup } from '@codetime/shared'
import {
  AGENT_ROLLUP_SCHEMA_VERSION,
  createImportKey,
  createPayloadHash,
  createStableHash,
} from '@codetime/shared'
import { displayBackfillPath } from '../lib/activity.js'
import { ROLLUP_BUCKET_MS, TURN_GAP_CLAMP_MS } from '../lib/constants.js'
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
  // Keyed by `${bucketTs}\0${model}` (v3 per-(15-min bucket, model) token buckets).
  const modelBuckets = new Map<string, NonNullable<SessionRollup['modelBuckets']>[number]>()
  const toolRollups = new Map<string, SessionRollup['toolRollups'][number]>()
  const fileRollups = new Map<string, SessionRollup['fileRollups'][number]>()
  const turnRollups = new Map<string, NonNullable<SessionRollup['turnRollups']>[number]>()
  // All event timestamps observed per turn (including the turn.completed event).
  // Used to compute a gap-clamped active duration instead of lastEventAt - startedAt.
  const turnEventTimes = new Map<string, string[]>()

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
    // TTL split subsets of cacheCreation; 0 when the agent doesn't report them.
    const eventCacheCreation5mInputTokens = Math.max(0, event.metrics?.tokensCacheCreation5mInput || 0)
    const eventCacheCreation1hInputTokens = Math.max(0, event.metrics?.tokensCacheCreation1hInput || 0)
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

      // Record every event ts for this turn (turn.completed included) so the final
      // duration can be a gap-clamped sum of active intervals.
      const times = turnEventTimes.get(event.turnId)
      if (times) {
        times.push(event.ts)
      }
      else {
        turnEventTimes.set(event.turnId, [event.ts])
      }
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
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
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
      modelRollup.cacheCreation5mInputTokens! += eventCacheCreation5mInputTokens
      modelRollup.cacheCreation1hInputTokens! += eventCacheCreation1hInputTokens
      modelRollup.cacheReadInputTokens += eventCacheReadInputTokens
      modelRollup.outputTokens += eventOutputTokens
      modelRollup.reasoningOutputTokens += eventReasoningOutputTokens
      modelRollup.totalTokens += eventTotalTokens
      modelRollup.estimatedCostUsd += eventCostUsd
      modelRollups.set(modelKey, modelRollup)

      // Per-(15-min bucket, model) token bucket (v3).
      const modelBucketKey = `${bucketTs}\0${modelKey}`
      const modelBucket = modelBuckets.get(modelBucketKey) || {
        ts: bucketTs,
        model: modelKey,
        callCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      }
      modelBucket.callCount += 1
      modelBucket.inputTokens += eventInputTokens
      modelBucket.cachedInputTokens += eventCachedInputTokens
      modelBucket.cacheCreationInputTokens += eventCacheCreationInputTokens
      modelBucket.cacheCreation5mInputTokens += eventCacheCreation5mInputTokens
      modelBucket.cacheCreation1hInputTokens += eventCacheCreation1hInputTokens
      modelBucket.cacheReadInputTokens += eventCacheReadInputTokens
      modelBucket.outputTokens += eventOutputTokens
      modelBucket.reasoningOutputTokens += eventReasoningOutputTokens
      modelBucket.totalTokens += eventTotalTokens
      modelBuckets.set(modelBucketKey, modelBucket)
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
    // v3 schema: v2 (gap-clamped turn durations + billable-output token
    // convention) plus per-model cache-creation TTL split and modelBuckets. Set on
    // baseRollup (not after) so it participates in payloadHash: every historical
    // rollup's hash changes, and a re-backfill (uploaded with replace=true by
    // default) cleanly refreshes all data onto the new convention. This
    // full-refresh churn is intentional.
    schemaVersion: AGENT_ROLLUP_SCHEMA_VERSION,
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
    // Sorted ts ascending, then model lexicographically (wire contract).
    modelBuckets: [...modelBuckets.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.model.localeCompare(b.model)),
    toolRollups: [...toolRollups.values()].sort((a, b) => b.callCount - a.callCount || a.tool.localeCompare(b.tool)),
    fileRollups: [...fileRollups.values()].sort((a, b) => b.writes - a.writes || b.reads - a.reads || a.displayPath.localeCompare(b.displayPath)),
    turnRollups: [...turnRollups.values()]
      .map(rollup => ({
        ...rollup,
        // Gap-clamped active duration: startedAt/lastEventAt/completedAt keep their
        // real timestamps, but durationMs only counts active intervals so lazy
        // completed_at timestamps and long in-turn silences don't inflate it.
        durationMs: gapClampedTurnDurationMs(rollup, turnEventTimes.get(rollup.turnId) || []),
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
  }

  return {
    ...baseRollup,
    payloadHash: createPayloadHash(baseRollup),
  }
}

// Active duration of a turn: dedupe and sort all of its event timestamps (with
// promptSubmittedAt/startedAt as the series start) and sum the gaps between
// consecutive events, clamping each gap to TURN_GAP_CLAMP_MS. A single-event turn
// has duration 0. This keeps long but continuously-busy turns intact while
// discarding idle stretches and lazy completed_at timestamps.
function gapClampedTurnDurationMs(
  rollup: NonNullable<SessionRollup['turnRollups']>[number],
  eventTimes: string[],
): number {
  const millis = [
    rollup.promptSubmittedAt,
    rollup.startedAt,
    ...eventTimes,
  ]
    .map(ts => (ts ? Date.parse(ts) : Number.NaN))
    .filter(ms => Number.isFinite(ms))
  const unique = [...new Set(millis)].sort((a, b) => a - b)
  if (unique.length < 2) {
    return 0
  }
  let duration = 0
  for (let i = 1; i < unique.length; i += 1) {
    duration += Math.min(unique[i] - unique[i - 1], TURN_GAP_CLAMP_MS)
  }
  return Math.max(0, duration)
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
  // Billable-output convention: reasoning tokens are already folded into
  // tokensOutput, so the fallback is input + output (adding reasoning again would
  // double-count it).
  return (
    Math.max(0, event.metrics?.tokensInput || 0)
    + Math.max(0, event.metrics?.tokensOutput || 0)
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
