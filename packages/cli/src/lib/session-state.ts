import type { CanonicalEvent } from '@codetime/shared'
import type { ParsedArgs } from './types.js'
import { createStableHash } from '@codetime/shared'
import { withBackfillRefs } from './backfill.js'
import { durationMsBetween } from './jsonl.js'

/**
 * Shared state machine for JSONL session parsers.
 *
 * Encapsulates the `push` / `ensureSessionStarted` / `closeTurn` / `startTurn`
 * pattern that is duplicated across Claude Code and Pi adapters.
 *
 * Usage:
 *   const state = new SessionParserState(filePath, options, baseEventFactory);
 *   state.parseLines(lines, (raw, ts, lineNumber) => { ... });
 */
export class SessionParserState {
  readonly events: CanonicalEvent[] = []
  readonly sourcePathHash: string
  sessionId: string | undefined
  sessionStarted = false
  currentTurnId: string | undefined
  currentTurnStartedAt: string | undefined
  currentTurnLastEventAt: string | undefined

  private readonly filePath: string
  private readonly options: ParsedArgs
  private readonly baseEventFn: (
    event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId'>,
  ) => CanonicalEvent

  constructor(
    filePath: string,
    options: ParsedArgs,
    baseEvent: (event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId'>) => CanonicalEvent,
  ) {
    this.filePath = filePath
    this.options = options
    this.sourcePathHash = `sha256:${createStableHash(filePath)}`
    this.baseEventFn = baseEvent
  }

  /** Push an event into the output array with backfill refs attached. */
  push(
    event: CanonicalEvent,
    lineNumber: number,
    topType?: string,
    payloadType?: string,
  ): void {
    if (event.turnId && event.turnId === this.currentTurnId && event.ts && (
      !this.currentTurnLastEventAt
        || event.ts > this.currentTurnLastEventAt
    )) {
      this.currentTurnLastEventAt = event.ts
    }

    this.events.push(
      withBackfillRefs(event, {
        filePath: this.filePath,
        sourcePathHash: this.sourcePathHash,
        lineNumber,
        topType: topType || 'message',
        payloadType: payloadType || event.type,
        options: this.options,
      }),
    )
  }

  /** Idempotent: emit a session.started event the first time called. */
  ensureSessionStarted(
    ts: string,
    lineNumber: number,
    topType?: string,
  ): void {
    if (this.sessionStarted) {
      return
    }
    this.sessionStarted = true
    this.push(
      this.baseEvent(this.sessionId, { ts, type: 'session.started', confidence: 'derived' }),
      lineNumber,
      topType,
      'session',
    )
  }

  /** Emit turn.completed for the current turn. */
  closeTurn(
    ts: string,
    lineNumber: number,
    topType?: string,
  ): void {
    if (!this.currentTurnId) {
      return
    }
    const closedAt = this.currentTurnLastEventAt || this.currentTurnStartedAt
    if (!closedAt) {
      return
    }

    this.push(
      this.baseEvent(this.sessionId, {
        ts: closedAt,
        type: 'turn.completed',
        turnId: this.currentTurnId,
        confidence: 'derived',
        metrics: {
          durationMs: durationMsBetween(this.currentTurnStartedAt, closedAt),
          turns: 1,
        },
      }),
      lineNumber,
      topType,
      'turn',
    )
  }

  /** Start a new turn. */
  startTurn(turnId: string, ts: string): void {
    this.currentTurnId = turnId
    this.currentTurnStartedAt = ts
    this.currentTurnLastEventAt = ts
  }

  private baseEvent(
    sessionId: string | undefined,
    event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId'>,
  ): CanonicalEvent {
    return {
      ...this.baseEventFn(event),
      sessionId: event.sessionId ?? sessionId,
    }
  }
}
