import type { CanonicalEvent } from '@codetime/shared'
import type { AgentAdapter, InstallEntry } from './types.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createStableHash,
  createWorkspaceId,
  validateCanonicalEvent,
} from '@codetime/shared'
import {
  addResolvedPathActivity,
  eventTypeFromFileActivities,
  operationForTool,
  summarizeFileActivities,
} from '../lib/activity.js'
import { hookHandler, isHooksJsonInstalled, sessionIdFromFilePath } from '../lib/adapter-helpers.js'
import { withBackfillRefs } from '../lib/backfill.js'
import { fileActivitiesFromPatchChanges } from '../lib/diff.js'
import {
  isPlainObject,
  numberField,
  objectField,
  stringField,
  stringRefs,
} from '../lib/fields.js'
import { durationMsBetween, durationObjectToMs, parseJsonLine, timestampFrom } from '../lib/jsonl.js'
import { fileActivitiesFromShellCommand } from '../lib/shell.js'

// ── Parser ──

async function parseCodexSessionFile(
  filePath: string,
  options: Record<string, unknown> & { _: string[] },
): Promise<CanonicalEvent[]> {
  const text = await readFile(filePath, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  const sourcePathHash = `sha256:${createStableHash(filePath)}`
  const events: CanonicalEvent[] = []
  let sessionId = sessionIdFromFilePath(filePath, 'codex')
  let cwd: string | undefined
  let project: string | undefined
  let model: string | undefined
  let currentTurnId: string | undefined
  let lastTurnIdForComplete: string | undefined
  // Track the turn_id that was active when the previous user_message arrived. Older Codex
  // sessions emit only one turn_context for the whole file, leaving every prompt sharing
  // the same turn_id. Detect that case and synthesize a per-prompt turn_id so each prompt
  // becomes its own activity segment.
  let turnIdAtLastUserMessage: string | undefined
  // Forked subagent rollouts include a second session_meta replaying the parent session.
  // Lock session/identity to the first session_meta so per-fork rollouts don't get
  // re-attributed to the parent session_id.
  let sessionMetaLocked = false
  // Codex sometimes emits multiple token_count events with an identical last_token_usage
  // (e.g. when only rate_limits metadata changes). Dedupe to avoid double-counting tokens
  // and inflating estimated cost.
  let lastTokenUsageKey: string | undefined
  const pendingToolCalls = new Map<string, { tool: string, startedAt: string, turnId: string | undefined }>()

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const raw = parseJsonLine(line)
    if (!raw) {
      continue
    }

    const payload = objectField(raw, 'payload')
    const topType = stringField(raw, 'type')
    const payloadType = stringField(payload, 'type')
    const ts = timestampFrom(raw.timestamp) || timestampFrom(payload.timestamp) || new Date().toISOString()

    if (topType === 'session_meta') {
      if (sessionMetaLocked) {
        // Replayed parent session_meta in a forked subagent rollout — ignore so
        // session_id, cwd, project, and model stay anchored to this rollout's own meta.
        continue
      }
      sessionMetaLocked = true
      sessionId = stringField(payload, 'id') || sessionId
      cwd = stringField(payload, 'cwd') || cwd
      project = cwd ? path.basename(cwd) : project
      model = stringField(payload, 'model_provider') || model
      events.push(withBackfillRefs({
        schemaVersion: AGENT_TIME_SCHEMA_VERSION,
        ts,
        source: 'codex',
        agent: 'codex',
        type: 'session.started',
        sessionId,
        cwd,
        project,
        workspaceId: createWorkspaceId({ projectName: project, repoRoot: cwd }),
        model,
        confidence: 'exact',
      }, { filePath, sourcePathHash, lineNumber, topType, payloadType: 'session_meta', options }))
      continue
    }

    if (topType === 'turn_context') {
      currentTurnId = stringField(payload, 'turn_id') || currentTurnId
      cwd = stringField(payload, 'cwd') || cwd
      project = cwd ? path.basename(cwd) : project
      model = stringField(payload, 'model') || model
      continue
    }

    if (topType !== 'event_msg' && topType !== 'response_item') {
      continue
    }

    switch (payloadType) {
      case 'task_started': {
        currentTurnId = stringField(payload, 'turn_id') || currentTurnId
        events.push(withBackfillRefs(baseCodexEvent({
          ts,
          type: 'turn.started',
          sessionId,
          turnId: currentTurnId,
          cwd,
          project,
          model,
          confidence: 'exact',
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))

        break
      }
      case 'user_message': {
        const message = stringField(payload, 'message') || ''
        // Close previous turn before starting a new one
        if (currentTurnId && currentTurnId !== turnIdAtLastUserMessage && lastTurnIdForComplete) {
          events.push(withBackfillRefs(baseCodexEvent({
            ts,
            type: 'turn.completed',
            sessionId,
            turnId: lastTurnIdForComplete,
            cwd,
            project,
            model,
            confidence: 'derived',
          }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))
        }
        if (!currentTurnId || currentTurnId === turnIdAtLastUserMessage) {
          currentTurnId = `turn_${createStableHash([sessionId, lineNumber, ts]).slice(0, 24)}`
        }
        lastTurnIdForComplete = currentTurnId
        turnIdAtLastUserMessage = currentTurnId
        events.push(withBackfillRefs(baseCodexEvent({
          ts,
          type: 'prompt.submitted',
          sessionId,
          turnId: currentTurnId,
          cwd,
          project,
          model,
          confidence: 'exact',
          metrics: {
            prompts: 1,
            promptChars: message.length,
          },
          refs: stringRefs({
            promptHash: message ? `sha256:${createStableHash(message)}` : undefined,
          }),
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))

        break
      }
      case 'token_count': {
        const usage = tokenUsageFromPayload(payload)
        if (usage) {
          const usageKey = [
            usage.tokensInput,
            usage.tokensCachedInput,
            usage.tokensOutput,
            usage.tokensReasoningOutput,
            usage.tokensTotal,
          ].join(':')
          if (usageKey === lastTokenUsageKey) {
            break
          }
          lastTokenUsageKey = usageKey
          events.push(withBackfillRefs(baseCodexEvent({
            ts,
            type: 'model.usage',
            sessionId,
            turnId: currentTurnId,
            cwd,
            project,
            model,
            confidence: 'partial',
            metrics: usage,
          }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))
        }

        break
      }
      case 'agent_message': {
        const message = stringField(payload, 'message') || ''
        events.push(withBackfillRefs(baseCodexEvent({
          ts,
          type: 'agent.operation',
          operation: 'agent message',
          sessionId,
          turnId: currentTurnId,
          cwd,
          project,
          model,
          confidence: 'derived',
          metrics: {
            agentMessageChars: message.length,
          },
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))

        break
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'web_search_call': {
        const tool = toolNameFromPayload(payload, payloadType)
        const callId = stringField(payload, 'call_id')
        const fileActivities = fileActivitiesFromFunctionCall(payload, payloadType, ts, cwd)

        if (callId) {
          pendingToolCalls.set(callId, { tool, startedAt: ts, turnId: currentTurnId })
        }

        events.push(withBackfillRefs(baseCodexEvent({
          ts,
          type: 'tool.started',
          operation: `${tool} started`,
          sessionId,
          turnId: currentTurnId,
          cwd,
          project,
          model,
          tool,
          confidence: 'exact',
          metrics: {
            toolCalls: 1,
          },
          refs: stringRefs({
            sourceId: callId,
          }),
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))
        if (fileActivities.length > 0) {
          events.push(withBackfillRefs(baseCodexEvent({
            ts,
            type: eventTypeFromFileActivities(fileActivities),
            operation: `${tool} file activity`,
            sessionId,
            turnId: currentTurnId,
            cwd,
            project,
            model,
            tool,
            confidence: 'derived',
            fileActivities,
            metrics: summarizeFileActivities(fileActivities),
            refs: stringRefs({
              sourceId: callId,
            }),
          }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))
        }

        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = stringField(payload, 'call_id')
        const pending = callId ? pendingToolCalls.get(callId) : undefined
        if (callId) {
          pendingToolCalls.delete(callId)
        }
        const durationMs = pending ? durationMsBetween(pending.startedAt, ts) : undefined

        events.push(withBackfillRefs(baseCodexEvent({
          ts,
          type: 'tool.completed',
          operation: pending ? `${pending.tool} completed` : 'tool completed',
          sessionId,
          turnId: pending?.turnId || currentTurnId,
          cwd,
          project,
          model,
          tool: pending?.tool,
          confidence: 'partial',
          metrics: durationMs
            ? {
                toolDurationMs: durationMs,
                durationMs,
              }
            : undefined,
          refs: stringRefs({
            sourceId: callId,
          }),
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))

        break
      }
      case 'exec_command_end': {
        const durationMs = durationObjectToMs(objectField(payload, 'duration'))
        const success = Number(payload.exit_code) === 0
        events.push(withBackfillRefs(baseCodexEvent({
          ts,
          type: success ? 'command.completed' : 'command.failed',
          operation: 'command completed',
          sessionId,
          turnId: stringField(payload, 'turn_id') || currentTurnId,
          cwd: stringField(payload, 'cwd') || cwd,
          project,
          model,
          tool: 'exec_command',
          success,
          confidence: 'exact',
          metrics: {
            commandCalls: 1,
            commandDurationMs: durationMs,
            durationMs,
          },
          refs: stringRefs({
            sourceId: stringField(payload, 'call_id'),
            commandHash: createStableHash(payload.command),
          }),
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))

        break
      }
      case 'patch_apply_end': {
        const fileActivities = fileActivitiesFromPatchChanges(
          objectField(payload, 'changes'),
          ts,
          cwd,
          displayFilePath,
        )
        events.push(withBackfillRefs(baseCodexEvent({
          ts,
          type: 'file.changed',
          operation: 'apply patch',
          sessionId,
          turnId: stringField(payload, 'turn_id') || currentTurnId,
          cwd,
          project,
          model,
          tool: 'apply_patch',
          success: Boolean(payload.success),
          confidence: 'derived',
          fileActivities,
          metrics: summarizeFileActivities(fileActivities),
          refs: stringRefs({
            sourceId: stringField(payload, 'call_id'),
          }),
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))

        break
      }
      case 'task_complete': {
        events.push(withBackfillRefs(baseCodexEvent({
          ts,
          type: 'turn.completed',
          sessionId,
          turnId: stringField(payload, 'turn_id') || currentTurnId,
          cwd,
          project,
          model,
          confidence: 'exact',
          metrics: {
            durationMs: numberField(payload, 'duration_ms'),
          },
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options }))

        break
      }
    // No default
    }
  }

  // Close the last turn if no task_complete was emitted for it
  if (lastTurnIdForComplete) {
    const lastTs = events.length > 0 ? events.at(-1)!.ts : new Date().toISOString()
    events.push(withBackfillRefs(baseCodexEvent({
      ts: lastTs,
      type: 'turn.completed',
      sessionId,
      turnId: lastTurnIdForComplete,
      cwd,
      project,
      model,
      confidence: 'derived',
    }), { filePath, sourcePathHash, lineNumber: lines.length, topType: 'event_msg', payloadType: 'turn.completed', options }))
  }

  return events.filter(event => validateCanonicalEvent(event).valid)
}

// ── Codex-specific helpers ──

function baseCodexEvent(
  event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId'>,
): CanonicalEvent {
  return {
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    source: 'codex',
    agent: 'codex',
    workspaceId: createWorkspaceId({ projectName: event.project, repoRoot: event.cwd }),
    ...event,
  }
}

export function tokenUsageFromPayload(payload: Record<string, unknown>) {
  const info = objectField(payload, 'info')
  const usage = objectField(info, 'last_token_usage')
  if (Object.keys(usage).length === 0) {
    return
  }

  return {
    tokensInput: numberField(usage, 'input_tokens'),
    tokensCachedInput: numberField(usage, 'cached_input_tokens'),
    tokensOutput: numberField(usage, 'output_tokens'),
    tokensReasoningOutput: numberField(usage, 'reasoning_output_tokens'),
    tokensTotal: numberField(usage, 'total_tokens'),
    modelContextWindow: numberField(info, 'model_context_window'),
  }
}

function toolNameFromPayload(payload: Record<string, unknown>, payloadType: string): string {
  if (payloadType === 'web_search_call') {
    return 'web_search'
  }
  return stringField(payload, 'name') || 'tool'
}

function fileActivitiesFromFunctionCall(
  payload: Record<string, unknown>,
  payloadType: string,
  ts: string,
  cwd: string | undefined,
): import('@codetime/shared').FileActivityRecord[] {
  const tool = toolNameFromPayload(payload, payloadType)
  const args = functionCallArguments(payload)
  const operation = operationForTool(tool)
  const workdir = stringField(args, 'workdir') || cwd
  const changes = new Map<string, import('@codetime/shared').FileActivityRecord>()

  for (const key of ['file_path', 'path', 'notebook_path']) {
    addResolvedPathActivity(changes, stringField(args, key), operation, ts, cwd, workdir)
  }
  for (const file of arrayField(args, 'files')) {
    if (typeof file === 'string') {
      addResolvedPathActivity(changes, file, operation, ts, cwd, workdir)
    }
  }

  const command = stringField(args, 'command') || stringField(args, 'cmd')
  if (command) {
    for (const item of fileActivitiesFromShellCommand(command, ts, cwd, workdir)) {
      changes.set(item.path, item)
    }
  }

  return [...changes.values()]
}

function arrayField(object: unknown, key: string): unknown[] {
  if (!isPlainObject(object) || !Array.isArray(object[key])) {
    return []
  }
  return object[key] as unknown[]
}

function functionCallArguments(payload: Record<string, unknown>): Record<string, unknown> {
  const args = payload.arguments
  if (isPlainObject(args)) {
    return args
  }
  if (typeof args !== 'string') {
    return {}
  }
  try {
    const parsed = JSON.parse(args)
    return isPlainObject(parsed) ? parsed : {}
  }
  catch {
    return {}
  }
}

function displayFilePath(filePath: string, cwd: string | undefined): string {
  if (!cwd || !path.isAbsolute(filePath)) {
    return filePath
  }
  const relative = path.relative(cwd, filePath)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath
}

// ── Installation ──

const codexHandler = (msg: string) => hookHandler('codex', msg)

function hookConfig(): object {
  const anyTool = [{ matcher: '.*', hooks: [codexHandler('Reporting tool activity')] }]

  return {
    hooks: {
      SessionStart: [{ hooks: [codexHandler('Reporting session start')] }],
      UserPromptSubmit: [{ hooks: [codexHandler('Reporting prompt activity')] }],
      PreToolUse: anyTool,
      PermissionRequest: anyTool,
      PostToolUse: anyTool,
      Stop: [{ hooks: [codexHandler('Reporting turn completion')] }],
    },
  }
}

// ── Adapter factory ──

export function createCodexAdapter(): AgentAdapter {
  const CODE_PATH = '.codex'

  return {
    id: 'codex',
    label: 'Codex',
    agentName: 'codex',
    kind: 'agent',

    detectPath(home: string) {
      return path.join(home, CODE_PATH)
    },
    installedPath(home: string) {
      return path.join(home, CODE_PATH, 'hooks.json')
    },

    async isInstalled(home: string) {
      return isHooksJsonInstalled(
        path.join(home, CODE_PATH, 'hooks.json'),
        'codetime hook --agent codex',
      )
    },

    installEntries(home: string): InstallEntry[] {
      return [{
        kind: 'hooks-json',
        path: path.join(home, CODE_PATH, 'hooks.json'),
        content: hookConfig(),
      }]
    },

    sourcePaths(home: string): string[] {
      return [
        path.join(home, '.codex', 'sessions'),
        path.join(home, '.codex', 'history.jsonl'),
      ]
    },

    parseSessionFile: parseCodexSessionFile,
  }
}
