import type { CanonicalEvent, MetricBag } from '@codetime/shared'
import type { AdapterEnv, AgentAdapter, InstallEntry } from './types.js'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createStableHash,
  createWorkspaceId,
} from '@codetime/shared'
import { matchesBackfillFilters, withBackfillRefs } from '../lib/backfill.js'
import { numberField, objectField, stringField, stringRefs } from '../lib/fields.js'
import { pathExists } from '../lib/fs.js'

interface BackfillSourceFile {
  path: string
  modifiedAt: string
}

type SqlValue = string | number | null

type SessionRow = Record<string, SqlValue>
type MessageRow = Record<string, SqlValue>

export async function hermesBackfillFiles(
  sourceRoot: string | undefined,
  home: string,
  env: AdapterEnv | undefined,
): Promise<BackfillSourceFile[]> {
  const filePath = sourceRoot ? path.resolve(sourceRoot) : hermesStateDb(home, env)
  if (!(await pathExists(filePath))) {
    return []
  }
  const info = await stat(filePath)
  return [{ path: filePath, modifiedAt: info.mtime.toISOString() }]
}

async function parseHermesStateDb(
  filePath: string,
  options: Record<string, unknown> & { _: string[] },
): Promise<CanonicalEvent[]> {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(filePath, { readOnly: true })
    const sessions = db.prepare(`
      SELECT id, source, model, model_config, started_at, ended_at, end_reason,
             message_count, tool_call_count, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, reasoning_tokens,
             billing_provider, estimated_cost_usd, actual_cost_usd, title
      FROM sessions
      ORDER BY started_at ASC
    `).all() as SessionRow[]

    const events: CanonicalEvent[] = []
    const sourcePathHash = `sha256:${createStableHash(filePath)}`
    let syntheticLine = 0

    for (const session of sessions) {
      const sessionId = stringField(session, 'id') || `hermes_${syntheticLine}`
      const startedAt = timestampFromUnix(numberField(session, 'started_at')) || new Date().toISOString()
      const endedAt = timestampFromUnix(numberField(session, 'ended_at'))
      const model = stringField(session, 'model') || modelFromConfig(stringField(session, 'model_config'))
      const title = stringField(session, 'title')
      const project = 'hermes'
      const workspaceId = createWorkspaceId({ projectName: project })

      push(events, baseHermesEvent({
        ts: startedAt,
        type: 'session.started',
        sessionId,
        project,
        workspaceId,
        model,
        confidence: 'exact',
        metrics: compactMetrics({}),
        refs: stringRefs({ title }),
      }), filePath, sourcePathHash, ++syntheticLine, 'sessions', 'session.started', options)

      const messageRows = db.prepare(`
        SELECT id, role, content, tool_calls, tool_name, timestamp, token_count, finish_reason
        FROM messages
        WHERE session_id = ?
        ORDER BY timestamp ASC, id ASC
      `).all(sessionId) as MessageRow[]

      let currentTurnId: string | undefined
      for (const message of messageRows) {
        const messageId = numberField(message, 'id')
        const ts = timestampFromUnix(numberField(message, 'timestamp')) || startedAt
        const role = stringField(message, 'role')
        const content = stringField(message, 'content') || ''
        const line = ++syntheticLine
        const sourceId = messageId === undefined ? undefined : String(messageId)

        if (role === 'user') {
          if (currentTurnId) {
            push(events, baseHermesEvent({
              ts,
              type: 'turn.completed',
              sessionId,
              turnId: currentTurnId,
              project,
              workspaceId,
              model,
              confidence: 'derived',
            }), filePath, sourcePathHash, line, 'messages', 'turn.completed', options)
          }
          currentTurnId = `turn_${createStableHash([sessionId, sourceId || line, ts]).slice(0, 24)}`
          push(events, baseHermesEvent({
            ts,
            type: 'turn.started',
            sessionId,
            turnId: currentTurnId,
            project,
            workspaceId,
            model,
            confidence: 'derived',
            refs: stringRefs({ sourceId }),
          }), filePath, sourcePathHash, line, 'messages', 'turn.started', options)
          push(events, baseHermesEvent({
            ts,
            type: 'prompt.submitted',
            sessionId,
            turnId: currentTurnId,
            project,
            workspaceId,
            model,
            confidence: 'partial',
            metrics: compactMetrics({ prompts: 1, promptChars: content.length }),
            refs: stringRefs({
              sourceId,
              promptHash: content ? `sha256:${createStableHash(content)}` : undefined,
            }),
          }), filePath, sourcePathHash, line, 'messages', 'prompt.submitted', options)
        }

        const toolCalls = parseToolCalls(stringField(message, 'tool_calls'))
        for (const [toolIndex, tool] of toolCalls.entries()) {
          const toolName = tool.name || 'tool'
          push(events, baseHermesEvent({
            ts,
            type: 'tool.started',
            operation: `${toolName} started`,
            sessionId,
            turnId: currentTurnId,
            project,
            workspaceId,
            model,
            tool: toolName,
            confidence: 'partial',
            metrics: compactMetrics({ toolCalls: 1 }),
            refs: stringRefs({ sourceId: tool.id || `${sourceId || line}:${toolIndex}` }),
          }), filePath, sourcePathHash, ++syntheticLine, 'messages', 'tool.started', options)
        }
      }

      if (currentTurnId) {
        push(events, baseHermesEvent({
          ts: endedAt || startedAt,
          type: 'turn.completed',
          sessionId,
          turnId: currentTurnId,
          project,
          workspaceId,
          model,
          confidence: endedAt ? 'derived' : 'estimated',
        }), filePath, sourcePathHash, ++syntheticLine, 'messages', 'turn.completed', options)
      }

      const usageMetrics = compactMetrics({
        modelCalls: numberField(session, 'api_call_count'),
        tokensInput: sumNumbers(
          numberField(session, 'input_tokens'),
          numberField(session, 'cache_read_tokens'),
          numberField(session, 'cache_write_tokens'),
        ),
        tokensOutput: numberField(session, 'output_tokens'),
        tokensCachedInput: sumNumbers(numberField(session, 'cache_read_tokens'), numberField(session, 'cache_write_tokens')),
        tokensCacheReadInput: numberField(session, 'cache_read_tokens'),
        tokensCacheCreationInput: numberField(session, 'cache_write_tokens'),
        tokensReasoningOutput: numberField(session, 'reasoning_tokens'),
        tokensTotal: sumNumbers(
          numberField(session, 'input_tokens'),
          numberField(session, 'cache_read_tokens'),
          numberField(session, 'cache_write_tokens'),
          numberField(session, 'output_tokens'),
          numberField(session, 'reasoning_tokens'),
        ),
        costUsd: numberField(session, 'actual_cost_usd') ?? numberField(session, 'estimated_cost_usd'),
      })
      if (Object.keys(usageMetrics).length > 0) {
        push(events, baseHermesEvent({
          ts: endedAt || startedAt,
          type: 'model.usage',
          sessionId,
          project,
          workspaceId,
          model,
          confidence: 'exact',
          metrics: usageMetrics,
          refs: stringRefs({
            billingProvider: stringField(session, 'billing_provider'),
          }),
        }), filePath, sourcePathHash, ++syntheticLine, 'sessions', 'model.usage', options)
      }

      push(events, baseHermesEvent({
        ts: endedAt || startedAt,
        type: 'session.ended',
        sessionId,
        project,
        workspaceId,
        model,
        confidence: endedAt ? 'exact' : 'estimated',
        metrics: compactMetrics({
          turns: currentTurnId ? 1 : undefined,
          toolCalls: numberField(session, 'tool_call_count'),
        }),
        refs: stringRefs({ endReason: stringField(session, 'end_reason') }),
      }), filePath, sourcePathHash, ++syntheticLine, 'sessions', 'session.ended', options)
    }

    return events.filter(event => matchesBackfillFilters(event, options))
  }
  finally {
    db?.close()
  }
}

function push(
  events: CanonicalEvent[],
  event: CanonicalEvent,
  filePath: string,
  sourcePathHash: string,
  lineNumber: number,
  topType: string,
  payloadType: string,
  options: Record<string, unknown> & { _: string[] },
): void {
  events.push(withBackfillRefs(event, { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))
}

function baseHermesEvent(
  event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent'>,
): CanonicalEvent {
  return {
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    source: 'hermes',
    agent: 'hermes',
    ...event,
  }
}

function compactMetrics(metrics: Partial<MetricBag>): Partial<MetricBag> {
  return Object.fromEntries(
    Object.entries(metrics).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value !== 0),
  ) as Partial<MetricBag>
}

function sumNumbers(...values: Array<number | undefined>): number | undefined {
  const total = values.reduce<number>((sum, value) => sum + (value || 0), 0)
  return total || undefined
}

function timestampFromUnix(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined
  }
  return new Date(value * 1000).toISOString()
}

function modelFromConfig(text: string | undefined): string | undefined {
  if (!text) {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as unknown
    return stringField(objectField(parsed, 'model'), 'model') || stringField(parsed, 'model')
  }
  catch {
    return undefined
  }
}

function parseToolCalls(text: string | undefined): Array<{ id?: string, name?: string }> {
  if (!text) {
    return []
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(item => typeof item === 'object' && item !== null).map((item) => {
      const record = item as Record<string, unknown>
      const fn = objectField(record, 'function')
      return {
        id: stringField(record, 'id') || stringField(record, 'call_id'),
        name: stringField(fn, 'name') || stringField(record, 'name'),
      }
    })
  }
  catch {
    return []
  }
}

function hermesHome(home: string, env?: AdapterEnv): string {
  const override = env?.HERMES_HOME
  if (override && override.trim()) {
    return path.resolve(override)
  }
  return path.join(home, '.hermes')
}

function hermesStateDb(home: string, env?: AdapterEnv): string {
  return path.join(hermesHome(home, env), 'state.db')
}

export function createHermesAdapter(): AgentAdapter {
  return {
    id: 'hermes',
    label: 'Hermes',
    agentName: 'hermes',
    kind: 'agent',

    detectPath(home, env) {
      return hermesHome(home, env)
    },
    installedPath(home, env) {
      return hermesStateDb(home, env)
    },
    async isInstalled(home, env) {
      return pathExists(hermesStateDb(home, env))
    },
    installEntries(): InstallEntry[] {
      return []
    },

    sourcePaths(home, env) {
      return [hermesStateDb(home, env)]
    },

    parseSessionFile: parseHermesStateDb,
  }
}
