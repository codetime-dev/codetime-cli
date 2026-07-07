import type { CanonicalEvent, FileActivityRecord, MetricBag } from '@codetime/shared'
import type { AdapterEnv, AgentAdapter, InstallEntry } from './types.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createStableHash,
  createWorkspaceId,
} from '@codetime/shared'
import {
  addResolvedPathActivity,
  countTextLines,
  eventTypeFromFileActivities,
  operationForTool,
  summarizeFileActivities,
} from '../lib/activity.js'
import { isTurnIdle } from '../lib/adapter-helpers.js'
import { matchesBackfillFilters } from '../lib/backfill.js'
import {
  isPlainObject,
  numberField,
  objectField,
  stringField,
  stringRefs,
} from '../lib/fields.js'
import { durationMsBetween, parseJsonLine, timestampFrom } from '../lib/jsonl.js'
import { SessionParserState } from '../lib/session-state.js'
import { fileActivitiesFromShellCommand } from '../lib/shell.js'

// ── Parser ──

async function parsePiSessionFile(
  filePath: string,
  options: Record<string, unknown> & { _: string[] },
): Promise<CanonicalEvent[]> {
  const text = await readFile(filePath, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  let sessionId: string | undefined
  let cwd: string | undefined
  let project: string | undefined
  let model: string | undefined
  let turnStartedAt: string | undefined
  const pendingToolCalls = new Map<string, {
    toolName: string
    startedAt: string
    turnId: string | undefined
    input: Record<string, unknown>
  }>()

  const state = new SessionParserState(filePath, options, event =>
    basePiEvent({ ...event, cwd, project, model }))

  // Wrap push to merge workspaceId fallback
  const push = (event: CanonicalEvent, ln: number) => {
    state.push(
      { ...event, workspaceId: event.workspaceId || createWorkspaceId({ projectName: project, repoRoot: cwd }) },
      ln,
      'message',
      event.type,
    )
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const raw = parseJsonLine(line)
    if (!raw) {
      continue
    }

    const entryType = stringField(raw, 'type')
    const ts = timestampFrom(raw.timestamp) || new Date().toISOString()

    if (entryType === 'session') {
      sessionId = stringField(raw, 'id') || state.sessionId
      state.sessionId = sessionId || state.sessionId
      cwd = stringField(raw, 'cwd') || cwd
      project = cwd ? path.basename(cwd) : project
      continue
    }

    if (entryType === 'model_change') {
      model = stringField(raw, 'modelId') || model
      continue
    }

    if (entryType !== 'message') {
      continue
    }

    const message = objectField(raw, 'message')
    const role = stringField(message, 'role')

    if (role === 'user') {
      state.currentTurnStartedAt = turnStartedAt; state.closeTurn(ts, lineNumber)
      state.currentTurnId = stringField(raw, 'id') || `turn_${createStableHash([sessionId, lineNumber]).slice(0, 24)}`
      turnStartedAt = ts
      state.currentTurnStartedAt = ts
      state.currentTurnLastEventAt = ts

      state.ensureSessionStarted(ts, lineNumber)

      push(basePiEvent({
        ts,
        type: 'turn.started',
        sessionId,
        turnId: state.currentTurnId,
        cwd,
        project,
        model,
        confidence: 'derived',
      }), lineNumber)

      const promptText = piExtractTextContent(message.content)
      push(basePiEvent({
        ts,
        type: 'prompt.submitted',
        sessionId,
        turnId: state.currentTurnId,
        cwd,
        project,
        model,
        confidence: 'exact',
        metrics: {
          prompts: 1,
          promptChars: promptText.length,
        },
        refs: stringRefs({
          promptHash: promptText ? `sha256:${createStableHash(promptText)}` : undefined,
        }),
      }), lineNumber)
      continue
    }

    if (role === 'assistant') {
      state.ensureSessionStarted(ts, lineNumber)
      model = stringField(message, 'model') || model

      const usage = piUsageFromMessage(message)
      if (usage) {
        push(basePiEvent({
          ts,
          type: 'model.usage',
          sessionId,
          turnId: state.currentTurnId,
          cwd,
          project,
          model,
          confidence: 'exact',
          metrics: usage,
        }), lineNumber)
      }

      for (const item of piToolCallItems(message.content)) {
        const toolCallId = stringField(item, 'id') || `tool_${createStableHash([filePath, lineNumber, stringField(item, 'name') || 'tool']).slice(0, 24)}`
        const toolName = stringField(item, 'name') || 'tool'
        const toolInput = isPlainObject(item.arguments) ? item.arguments as Record<string, unknown> : {}

        pendingToolCalls.set(toolCallId, {
          toolName,
          startedAt: ts,
          turnId: state.currentTurnId,
          input: toolInput,
        })

        push(basePiEvent({
          ts,
          type: 'tool.started',
          operation: `${toolName} started`,
          sessionId,
          turnId: state.currentTurnId,
          cwd,
          project,
          model,
          tool: toolName,
          confidence: 'exact',
          metrics: { toolCalls: 1 },
          refs: stringRefs({
            sourceId: toolCallId,
            commandHash: toolName === 'bash' && stringField(toolInput, 'command')
              ? createStableHash(stringField(toolInput, 'command')!)
              : undefined,
          }),
        }), lineNumber)

        const fileActivities = piFileActivitiesFromToolCall(toolName, toolInput, ts, cwd)
        if (fileActivities.length > 0) {
          push(basePiEvent({
            ts,
            type: eventTypeFromFileActivities(fileActivities),
            operation: `${toolName} file activity`,
            sessionId,
            turnId: state.currentTurnId,
            cwd,
            project,
            model,
            tool: toolName,
            confidence: 'derived',
            fileActivities,
            metrics: summarizeFileActivities(fileActivities),
            refs: stringRefs({ sourceId: toolCallId }),
          }), lineNumber)
        }
      }
      continue
    }

    if (role === 'toolResult') {
      state.ensureSessionStarted(ts, lineNumber)
      const toolCallId = stringField(message, 'toolCallId')
      const toolName = stringField(message, 'toolName') || 'tool'
      const isError = Boolean(message.isError)
      const pending = toolCallId ? pendingToolCalls.get(toolCallId) : undefined
      const durationMs = pending ? durationMsBetween(pending.startedAt, ts) : undefined

      if (toolCallId) {
        pendingToolCalls.delete(toolCallId)
      }

      push(basePiEvent({
        ts,
        type: isError ? 'tool.failed' : 'tool.completed',
        operation: isError ? `${toolName} failed` : `${toolName} completed`,
        sessionId,
        turnId: pending?.turnId || state.currentTurnId,
        cwd,
        project,
        model,
        tool: toolName,
        success: !isError,
        confidence: 'exact',
        metrics: {
          toolDurationMs: durationMs,
          durationMs,
        },
        refs: stringRefs({ sourceId: toolCallId }),
      }), lineNumber)

      if (toolName === 'bash' || toolName === 'Bash') {
        push(basePiEvent({
          ts,
          type: isError ? 'command.failed' : 'command.completed',
          operation: 'command completed',
          sessionId,
          turnId: pending?.turnId || state.currentTurnId,
          cwd,
          project,
          model,
          tool: 'Bash',
          success: !isError,
          confidence: 'derived',
          metrics: {
            commandCalls: 1,
            commandDurationMs: durationMs,
            durationMs,
          },
          refs: stringRefs({
            sourceId: toolCallId,
            commandHash: pending?.input.command
              ? `sha256:${createStableHash(String(pending.input.command))}`
              : undefined,
          }),
        }), lineNumber)
      }
      continue
    }
  }

  // Close the last turn — the loop only calls closeTurn when the NEXT user
  // message arrives, so the final turn never gets turn.completed otherwise.
  // Use the turn's last event timestamp (not file mtime) so an idle gap shorter
  // than the 5-min file window still flips the session to idle.
  if (isTurnIdle(state.currentTurnLastEventAt)) {
    state.closeTurn(state.currentTurnLastEventAt!, lines.length)
  }

  return state.events.filter(event => matchesBackfillFilters(event, options))
}

// ── Pi-specific helpers ──

function basePiEvent(
  event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId' | 'confidence'>
    & { confidence?: CanonicalEvent['confidence'] },
): CanonicalEvent {
  return {
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    source: 'pi',
    agent: 'pi',
    workspaceId: createWorkspaceId({ projectName: event.project, repoRoot: event.cwd }),
    ...event,
  }
}

function piToolCallItems(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) {
    return []
  }
  return content.filter((item): item is Record<string, unknown> =>
    isPlainObject(item) && item.type === 'toolCall',
  )
}

function piExtractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter((item): item is Record<string, unknown> => isPlainObject(item) && item.type === 'text')
    .map(item => stringField(item, 'text') || '')
    .join('')
}

export function piUsageFromMessage(message: Record<string, unknown>): Partial<MetricBag> | undefined {
  const usage = objectField(message, 'usage')
  if (Object.keys(usage).length === 0) {
    return undefined
  }

  const input = numberField(usage, 'input') || 0
  const output = numberField(usage, 'output') || 0
  const cacheRead = numberField(usage, 'cacheRead') || 0
  const cacheWrite = numberField(usage, 'cacheWrite') || 0
  // ccusage apply_total_token_fallback: an explicit totalTokens can only ADD tokens
  // the parts don't account for (folded into billable output), never shrink the
  // parts sum. This both counts total-only records (output would otherwise be 0)
  // and stops an explicit total smaller than the parts from undercounting the grand
  // total.
  const explicitTotal = numberField(usage, 'totalTokens') || 0
  const partsSum = input + output + cacheRead + cacheWrite
  const missing = Math.max(0, explicitTotal - partsSum)
  const billableOutput = output + missing
  const totalTokens = partsSum + missing

  if (totalTokens <= 0) {
    return undefined
  }

  const cost = objectField(usage, 'cost')
  const costUsd = numberField(cost, 'total')

  return {
    tokensInput: (input + cacheRead + cacheWrite) || undefined,
    tokensOutput: billableOutput || undefined,
    tokensCachedInput: (cacheRead + cacheWrite) || undefined,
    tokensCacheReadInput: cacheRead || undefined,
    tokensCacheCreationInput: cacheWrite || undefined,
    tokensTotal: totalTokens,
    costUsd,
  }
}

function piFileActivitiesFromToolCall(
  tool: string,
  input: Record<string, unknown>,
  ts: string,
  cwd: string | undefined,
): FileActivityRecord[] {
  const changes = new Map<string, FileActivityRecord>()
  const operation = operationForTool(tool)
  const normalized = tool.toLowerCase()

  for (const key of ['file_path', 'path', 'filePath']) {
    const filePath = stringField(input, key)
    if (filePath) {
      addResolvedPathActivity(changes, filePath, operation, ts, cwd, cwd, piToolFileMetrics(normalized, input))
    }
  }

  if (normalized === 'bash' || normalized === 'run') {
    const command = stringField(input, 'command')
    if (command) {
      for (const item of fileActivitiesFromShellCommand(command, ts, cwd, cwd)) {
        const merged = changes.get(item.path)
        changes.set(item.path, {
          ts: item.ts,
          path: item.path,
          operation: merged?.operation || item.operation,
          bytesRead: sumOptional(merged?.bytesRead, item.bytesRead),
          bytesWritten: sumOptional(merged?.bytesWritten, item.bytesWritten),
          charsRead: sumOptional(merged?.charsRead, item.charsRead),
          charsWritten: sumOptional(merged?.charsWritten, item.charsWritten),
          linesRead: sumOptional(merged?.linesRead, item.linesRead),
          linesAdded: (merged?.linesAdded || 0) + (item.linesAdded || 0),
          linesRemoved: (merged?.linesRemoved || 0) + (item.linesRemoved || 0),
        })
      }
    }
  }

  return [...changes.values()]
}

function piToolFileMetrics(tool: string, input: Record<string, unknown>): Partial<FileActivityRecord> {
  if (tool === 'read') {
    return {
      linesRead: numberField(input, 'limit') || numberField(input, 'offset'),
    }
  }
  if (tool === 'write') {
    const content = stringField(input, 'content') || stringField(input, 'file_text')
    return {
      linesAdded: countTextLines(content),
      charsWritten: content?.length,
    }
  }
  if (tool === 'edit') {
    const oldText = stringField(input, 'oldText') || stringField(input, 'old_text') || stringField(input, 'oldString')
    const newText = stringField(input, 'newText') || stringField(input, 'new_text') || stringField(input, 'newString')
    return {
      linesAdded: countTextLines(newText),
      linesRemoved: countTextLines(oldText),
      charsWritten: newText?.length,
    }
  }
  return {}
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  const sum = (left || 0) + (right || 0)
  return sum || undefined
}

// ── Installation content (Pi extension) ──

function piExtensionContent(): string {
  return `// Agent Time extension for Pi
// Generated by codetime.

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function report(payload: Record<string, unknown>) {
  const child = spawn("codetime", ["hook", "--agent", "pi"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
}

export default function (pi: ExtensionAPI) {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let turnId: string | undefined;

  pi.on("session_start", async (event) => {
    sessionId = event.id;
    cwd = event.cwd;
    report({
      hook_event_name: "SessionStart",
      session_id: event.id,
      cwd: event.cwd,
    });
  });

  pi.on("session_shutdown", async (event) => {
    report({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      cwd,
      reason: event.reason,
    });
    sessionId = undefined;
    cwd = undefined;
  });

  pi.on("model_select", async (event) => {
    model = event.model.id;
  });

  pi.on("tool_execution_start", async (event) => {
    report({
      hook_event_name: "PreToolUse",
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      turn_id: turnId,
      session_id: sessionId,
      cwd,
      model,
      tool_input: event.args,
    });
  });

  pi.on("tool_execution_end", async (event) => {
    report({
      hook_event_name: event.isError ? "PostToolUseFailure" : "PostToolUse",
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      turn_id: turnId,
      session_id: sessionId,
      cwd,
      model,
      duration_ms: event.duration,
    });
  });

  pi.on("turn_start", async (event) => {
    turnId = "turn_" + event.turnIndex;
  });

  pi.on("turn_end", async (event) => {
    report({
      hook_event_name: "Stop",
      turn_id: turnId,
      session_id: sessionId,
      cwd,
      model: event.message?.model || model,
      duration_ms: event.turnDuration,
    });
    turnId = undefined;
  });

  pi.on("message_end", async (event) => {
    if (event.message.role === "user") {
      turnId = event.id;
      const text = typeof event.message.content === "string"
        ? event.message.content
        : event.message.content
            .filter((p: { type: string }) => p.type === "text")
            .map((p: { text: string }) => p.text)
            .join("");
      report({
        hook_event_name: "UserPromptSubmit",
        prompt: text,
        turn_id: event.id,
        session_id: sessionId,
        cwd,
      });
    }
  });
}
`
}

// ── Adapter factory ──

// Pi exposes two independent overrides: PI_CODING_AGENT_DIR moves the whole
// agent dir (extensions, config), while PI_CODING_AGENT_SESSION_DIR can shift
// just the sessions folder. Resolve them separately so codetime can find each.
function piAgentDir(home: string, env?: AdapterEnv): string {
  const override = env?.PI_CODING_AGENT_DIR
  if (override && override.trim()) {
    return path.resolve(override)
  }
  return path.join(home, '.pi', 'agent')
}

function piSessionDir(home: string, env?: AdapterEnv): string {
  const override = env?.PI_CODING_AGENT_SESSION_DIR
  if (override && override.trim()) {
    return path.resolve(override)
  }
  return path.join(piAgentDir(home, env), 'sessions')
}

export function createPiAdapter(): AgentAdapter {
  return {
    id: 'pi',
    label: 'Pi',
    agentName: 'pi',
    kind: 'agent',

    detectPath(home: string, env?: AdapterEnv) {
      return piAgentDir(home, env)
    },
    installedPath(home: string, env?: AdapterEnv) {
      return path.join(piAgentDir(home, env), 'extensions', 'codetime.ts')
    },

    async isInstalled(home: string, env?: AdapterEnv) {
      try {
        const { pathExists } = await import('../lib/fs.js')
        return await pathExists(path.join(piAgentDir(home, env), 'extensions', 'codetime.ts'))
      }
      catch {
        return false
      }
    },

    installEntries(home: string, env?: AdapterEnv): InstallEntry[] {
      return [{
        kind: 'file',
        path: path.join(piAgentDir(home, env), 'extensions', 'codetime.ts'),
        content: piExtensionContent(),
      }]
    },

    sourcePaths(home: string, env?: AdapterEnv): string[] {
      return [piSessionDir(home, env)]
    },

    parseSessionFile: parsePiSessionFile,
  }
}
