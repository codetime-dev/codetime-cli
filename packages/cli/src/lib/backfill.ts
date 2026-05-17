import type { BackfillSourceId, CanonicalEvent } from '@codetime/shared'
import { createImportKey, createStableEventId } from '@codetime/shared'
import { PACKAGE_VERSION } from './constants.js'
import { stringOption, stringRefs } from './fields.js'
import { timestampFrom } from './jsonl.js'

export interface BackfillSourceDefinition {
  id: BackfillSourceId
  label: string
  paths: string[]
}

export interface BackfillRefsContext {
  filePath: string
  sourcePathHash: string
  lineNumber: number
  topType: string | undefined
  payloadType: string | undefined
  options: Record<string, unknown> & { _: string[] }
}

export function withBackfillRefs(
  event: CanonicalEvent,
  context: BackfillRefsContext,
): CanonicalEvent {
  const importKey = createImportKey([
    event.source,
    context.sourcePathHash,
    context.lineNumber,
    event.type,
    event.refs?.sourceId,
  ])
  const refs: Record<string, string> = {
    ...stringRefs(event.refs),
    importKey,
    sourcePathHash: context.sourcePathHash,
    sourceLine: String(context.lineNumber),
    sourceType: context.topType || 'unknown',
    payloadType: context.payloadType || 'unknown',
    parserVersion: PACKAGE_VERSION,
  }

  if (context.options.includeSourcePath) {
    refs.transcriptPath = context.filePath
  }

  return {
    ...event,
    id: createStableEventId(importKey),
    refs,
  }
}

export function matchesBackfillFilters(
  event: CanonicalEvent,
  options: Record<string, unknown>,
): boolean {
  const since = timestampFrom(stringOption(options.since))
  const until = timestampFrom(stringOption(options.until))
  const eventTime = Date.parse(event.ts)
  const project = stringOption(options.project)

  if (since && eventTime < Date.parse(since)) {
    return false
  }
  if (until && eventTime > Date.parse(until)) {
    return false
  }
  if (project && event.project !== project) {
    return false
  }
  return true
}
