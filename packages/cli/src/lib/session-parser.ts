import type { CanonicalEvent } from '@codetime/shared'
import type { ParsedArgs } from './types.js'
import { readFile } from 'node:fs/promises'
import {
  createStableHash,
  validateCanonicalEvent,
} from '@codetime/shared'
import { matchesBackfillFilters, withBackfillRefs } from './backfill.js'
import { durationMsBetween, parseJsonLine, timestampFrom } from './jsonl.js'

/**
 * Base class for JSONL-based session file parsers.
 *
 * Subclasses implement `parseLine()` to handle one JSONL line and emit
 * events via `push()`.  The base class handles file I/O, source path
 * hashing, event filtering, and provides `push()`, `ensureSessionStarted()`,
 * and `closeTurn()` helpers.
 */
export abstract class JsonlSessionParser {
  protected events: CanonicalEvent[] = []
  protected filePath = ''
  protected sourcePathHash = ''
  protected options: ParsedArgs = { _: [] }
  protected sessionId: string | undefined
  protected sessionStarted = false
  protected currentTurnId: string | undefined
  protected currentTurnStartedAt: string | undefined
  protected currentTurnLastEventAt: string | undefined

  /** Build a base event pre-filled with source metadata. */
  abstract baseEvent(event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId'>): CanonicalEvent

  /** Extract session ID from the file path. */
  abstract sessionIdFromPath(filePath: string): string

  /**
   * Parse one JSONL line.  Call push() for each event emitted.
   */
  abstract parseLine(
    raw: Record<string, unknown>,
    ts: string,
    lineNumber: number
  ): void

  async parse(filePath: string, options: ParsedArgs): Promise<CanonicalEvent[]> {
    this.events = []
    this.filePath = filePath
    this.sourcePathHash = `sha256:${createStableHash(filePath)}`
    this.options = options
    this.sessionId = this.sessionIdFromPath(filePath)
    this.sessionStarted = false
    this.currentTurnId = undefined
    this.currentTurnStartedAt = undefined
    this.currentTurnLastEventAt = undefined

    const text = await readFile(filePath, 'utf8')
    const lines = text.split('\n').filter(Boolean)

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1
      const raw = parseJsonLine(line)
      if (!raw) {
        continue
      }

      const ts = timestampFrom(raw.timestamp) || new Date().toISOString()
      this.parseLine(raw, ts, lineNumber)
    }

    return this.events.filter(
      event =>
        validateCanonicalEvent(event).valid
        && matchesBackfillFilters(event, options),
    )
  }

  /** Push an event into the output array with backfill refs attached. */
  protected push(
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

  /** Emit a session.started event the first time called. Idempotent. */
  protected ensureSessionStarted(
    ts: string,
    lineNumber: number,
    topType?: string,
  ): void {
    if (this.sessionStarted) {
      return
    }
    this.sessionStarted = true
    this.push(
      this.baseEvent({
        ts,
        type: 'session.started',
        sessionId: this.sessionId,
        confidence: 'derived',
      }),
      lineNumber,
      topType,
      'session',
    )
  }

  /** Emit turn.completed for the current turn using the latest event timestamp. */
  protected closeTurn(
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
      this.baseEvent({
        ts: closedAt,
        type: 'turn.completed',
        sessionId: this.sessionId,
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

  /** Start a new turn. Call before emitting turn-scoped events. */
  protected startTurn(turnId: string, ts: string): void {
    this.currentTurnId = turnId
    this.currentTurnStartedAt = ts
    this.currentTurnLastEventAt = ts
  }
}
