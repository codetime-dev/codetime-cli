import type { CanonicalEvent, FileActivityRecord, MetricBag } from '@codetime/shared'
import type { AdapterEnv, AgentAdapter, InstallEntry } from './types.js'
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createStableHash,
  createWorkspaceId,
  validateCanonicalEvent,
} from '@codetime/shared'
import {
  addResolvedPathActivity,
  countTextLines,
  eventTypeFromFileActivities,
  mergeFileActivity,
  operationForTool,
  summarizeFileActivities,
} from '../lib/activity.js'
import { hookHandler, isHooksJsonInstalled, isTurnIdle, sessionIdFromFilePath } from '../lib/adapter-helpers.js'
import {
  isPlainObject,
  numberField,
  objectField,
  stringField,
  stringOption,
  stringRefs,
} from '../lib/fields.js'
import { durationMsBetween, parseJsonLine, timestampFrom } from '../lib/jsonl.js'
import { SessionParserState } from '../lib/session-state.js'
import { fileActivitiesFromShellCommand } from '../lib/shell.js'

interface ClaudePendingTool {
  id: string
  name: string
  startedAt: string
  lineNumber: number
  turnId?: string
  cwd?: string
  project?: string
  model?: string
  commandHash?: string
  agentInstanceId?: string
}

// ── Parser ──

async function parseClaudeCodeSessionFile(
  filePath: string,
  options: Record<string, unknown> & { _: string[] },
): Promise<CanonicalEvent[]> {
  const text = await readFile(filePath, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  const projectContext = await claudeProjectContextFromLines(filePath, lines, options)
  const pendingTools = new Map<string, ClaudePendingTool>()
  // Claude Code occasionally writes the same assistant message to the
  // jsonl more than once (streaming flushes, retries, replays). ccusage
  // dedups by `${messageId}:${requestId}` — without it codetime double-
  // counts tokens 2-6×. Track which usage rows we've already emitted.
  const seenUsageKeys = new Set<string>()
  let sessionId = sessionIdFromFilePath(filePath, 'claude')
  let cwd: string | undefined
  let project: string | undefined = projectContext.project
  let model: string | undefined

  const state = new SessionParserState(filePath, options, event =>
    baseClaudeEvent({ ...event, cwd, project, model }))
  state.sessionId = sessionId

  // Wrap state.push to merge projectContext.workspaceId
  const push = (event: CanonicalEvent, ln: number, topType?: string, payloadType?: string) => {
    state.push(
      { ...event, workspaceId: projectContext.workspaceId || event.workspaceId },
      ln,
      topType,
      payloadType,
    )
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const raw = parseJsonLine(line)
    if (!raw) {
      continue
    }

    const topType = stringField(raw, 'type')
    const ts = timestampFrom(raw.timestamp)
    sessionId = stringField(raw, 'sessionId') || sessionId
    state.sessionId = sessionId
    cwd = stringField(raw, 'cwd') || cwd
    project = projectContext.project || (cwd ? path.basename(cwd) : project || claudeProjectFromFilePath(filePath, options))

    if (!ts) {
      continue
    }
    state.ensureSessionStarted(ts, lineNumber, topType)

    const message = objectField(raw, 'message')
    if (topType === 'user' && isClaudeToolResultMessage(message)) {
      for (const result of claudeToolResultItems(message)) {
        const toolUseId = stringField(result, 'tool_use_id')
        const pending = toolUseId ? pendingTools.get(toolUseId) : undefined
        if (!pending) {
          continue
        }
        const toolResult = objectField(raw, 'toolUseResult')
        const success = !result.is_error && !toolResult.interrupted && toolResult.success !== false
        const durationMs = durationMsBetween(pending.startedAt, ts)
        const metrics = {
          toolCalls: 1,
          toolDurationMs: durationMs,
          durationMs,
        }

        push(baseClaudeEvent({
          ts,
          type: success ? 'tool.completed' : 'tool.failed',
          operation: `${pending.name} completed`,
          sessionId,
          turnId: pending.turnId,
          cwd: pending.cwd,
          project: pending.project,
          model: pending.model,
          tool: pending.name,
          success,
          confidence: 'exact',
          metrics,
          refs: stringRefs({
            sourceId: pending.id,
            commandHash: pending.commandHash,
          }),
        }), lineNumber, topType, 'tool_result')

        if (pending.name === 'Bash') {
          push(baseClaudeEvent({
            ts,
            type: success ? 'command.completed' : 'command.failed',
            operation: 'Bash completed',
            sessionId,
            turnId: pending.turnId,
            cwd: pending.cwd,
            project: pending.project,
            model: pending.model,
            tool: pending.name,
            success,
            confidence: 'derived',
            metrics: {
              commandCalls: 1,
              commandDurationMs: durationMs,
              durationMs,
            },
            refs: stringRefs({
              sourceId: pending.id,
              commandHash: pending.commandHash,
            }),
          }), lineNumber, topType, 'tool_result')
        }

        if (pending.agentInstanceId) {
          push(baseClaudeEvent({
            ts,
            type: 'subagent.ended',
            operation: 'subagent completed',
            sessionId,
            turnId: pending.turnId,
            agentInstanceId: pending.agentInstanceId,
            cwd: pending.cwd,
            project: pending.project,
            model: pending.model,
            tool: pending.name,
            success,
            confidence: 'derived',
            metrics: claudeSubagentMetrics(toolResult, durationMs),
            refs: stringRefs({
              sourceId: pending.id,
            }),
          }), lineNumber, topType, 'tool_result')
        }

        pendingTools.delete(pending.id)
      }
      continue
    }

    if (topType === 'user') {
      const prompt = claudeTextStats(message.content)
      state.closeTurn(ts, lineNumber, topType)
      state.currentTurnId = stringField(raw, 'uuid') || stringField(raw, 'promptId') || `turn_${createStableHash([sessionId, lineNumber]).slice(0, 24)}`
      state.currentTurnStartedAt = ts
      state.currentTurnLastEventAt = ts

      push(baseClaudeEvent({
        ts,
        type: 'turn.started',
        sessionId,
        turnId: state.currentTurnId,
        cwd,
        project,
        model,
        confidence: 'derived',
      }), lineNumber, topType, 'user')

      push(baseClaudeEvent({
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
          promptChars: prompt.chars,
        },
        refs: stringRefs({
          promptHash: prompt.hash,
        }),
      }), lineNumber, topType, 'user')
      continue
    }

    if (topType !== 'assistant') {
      continue
    }

    model = stringField(message, 'model') || model
    // Skip the entire assistant entry when (messageId, requestId) was
    // already processed — applies to both the usage metrics and any
    // tool_use items so we don't double-emit tool.started either.
    // When messageId is absent we cannot dedup safely — emit and accept
    // the risk (matches ccusage's createUniqueHash returning null).
    const messageId = stringField(message, 'id')
    const requestId = stringField(raw, 'requestId')
    const usageKey = messageId ? `${messageId}:${requestId}` : null
    if (usageKey != null && seenUsageKeys.has(usageKey)) {
      continue
    }
    if (usageKey != null) {
      seenUsageKeys.add(usageKey)
    }
    const usage = claudeUsageFromMessage(message)
    if (usage) {
      // Anthropic surfaces fast inference via `usage.speed === 'fast'`.
      // Append `-fast` so the model name lines up with OpenRouter's
      // separate `anthropic/claude-opus-4.7-fast` pricing entry (~6×
      // standard). Tag only the model.usage event to keep downstream
      // tool events on the base model name.
      const speed = stringField(objectField(message, 'usage'), 'speed')
      const usageModel = speed === 'fast' && model ? `${model}-fast` : model
      push(baseClaudeEvent({
        ts,
        type: 'model.usage',
        sessionId,
        turnId: state.currentTurnId,
        cwd,
        project,
        model: usageModel,
        confidence: 'partial',
        metrics: usage,
      }), lineNumber, topType, 'usage')
    }

    for (const toolUse of claudeToolUseItems(message)) {
      const tool = stringField(toolUse, 'name') || 'tool'
      const toolUseId = stringField(toolUse, 'id') || `tool_${createStableHash([filePath, lineNumber, tool]).slice(0, 24)}`
      const input = objectField(toolUse, 'input')
      const command = stringField(input, 'command')
      const fileActivities = fileActivitiesFromClaudeToolUse(tool, input, ts, cwd)
      const agentInstanceId = tool === 'Agent' ? `agent_${createStableHash([sessionId, toolUseId]).slice(0, 24)}` : undefined

      pendingTools.set(toolUseId, {
        id: toolUseId,
        name: tool,
        startedAt: ts,
        lineNumber,
        turnId: state.currentTurnId,
        cwd,
        project,
        model,
        commandHash: command ? createStableHash(command) : undefined,
        agentInstanceId,
      })

      push(baseClaudeEvent({
        ts,
        type: 'tool.started',
        operation: `${tool} started`,
        sessionId,
        turnId: state.currentTurnId,
        cwd,
        project,
        model,
        tool,
        confidence: 'exact',
        metrics: { toolCalls: 1 },
        refs: stringRefs({
          sourceId: toolUseId,
          commandHash: command ? createStableHash(command) : undefined,
        }),
      }), lineNumber, topType, 'tool_use')

      if (agentInstanceId) {
        push(baseClaudeEvent({
          ts,
          type: 'subagent.started',
          operation: 'subagent started',
          sessionId,
          turnId: state.currentTurnId,
          agentInstanceId,
          cwd,
          project,
          model,
          tool,
          confidence: 'derived',
          refs: stringRefs({ sourceId: toolUseId }),
        }), lineNumber, topType, 'tool_use')
      }

      if (fileActivities.length > 0) {
        push(baseClaudeEvent({
          ts,
          type: eventTypeFromFileActivities(fileActivities),
          operation: `${tool} file activity`,
          sessionId,
          turnId: state.currentTurnId,
          cwd,
          project,
          model,
          tool,
          confidence: 'derived',
          fileActivities,
          metrics: summarizeFileActivities(fileActivities),
          refs: stringRefs({
            sourceId: toolUseId,
            commandHash: command ? createStableHash(command) : undefined,
          }),
        }), lineNumber, topType, 'tool_use')
      }
    }
  }

  // Close the last turn — closeTurn is only called when the NEXT user message
  // arrives, so the final turn never gets turn.completed otherwise. Use the
  // turn's last event timestamp (not file mtime) so an idle gap shorter than
  // the 5-min file window still flips the session to idle.
  if (isTurnIdle(state.currentTurnLastEventAt)) {
    state.closeTurn(state.currentTurnLastEventAt!, lines.length)
  }

  return state.events.filter(event => validateCanonicalEvent(event).valid)
}

// ── Claude-specific helpers ──

function baseClaudeEvent(
  event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId'>,
): CanonicalEvent {
  return {
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    source: 'claude-code',
    agent: 'claude',
    workspaceId: createWorkspaceId({ projectName: event.project, repoRoot: event.cwd }),
    ...event,
  }
}

export function claudeUsageFromMessage(message: Record<string, unknown>): Partial<MetricBag> | undefined {
  const usage = objectField(message, 'usage')
  if (Object.keys(usage).length === 0) {
    return undefined
  }

  const inputTokens = numberField(usage, 'input_tokens') || 0
  const cacheCreationInputTokens = numberField(usage, 'cache_creation_input_tokens') || 0
  const cacheReadInputTokens = numberField(usage, 'cache_read_input_tokens') || 0
  const outputTokens = numberField(usage, 'output_tokens') || 0
  const cachedInputTokens = cacheCreationInputTokens + cacheReadInputTokens
  const totalInputTokens = inputTokens + cachedInputTokens

  return {
    tokensInput: totalInputTokens || undefined,
    tokensCachedInput: cachedInputTokens || undefined,
    tokensCacheCreationInput: cacheCreationInputTokens || undefined,
    tokensCacheReadInput: cacheReadInputTokens || undefined,
    tokensOutput: outputTokens || undefined,
    tokensTotal: totalInputTokens + outputTokens || undefined,
    modelCalls: 1,
  }
}

function claudeSubagentMetrics(
  toolResult: Record<string, unknown>,
  fallbackDurationMs: number | undefined,
): MetricBag {
  const usage = objectField(toolResult, 'usage')
  const inputTokens = numberField(usage, 'input_tokens') || 0
  const cacheCreationInputTokens = numberField(usage, 'cache_creation_input_tokens') || 0
  const cacheReadInputTokens = numberField(usage, 'cache_read_input_tokens') || 0
  const outputTokens = numberField(usage, 'output_tokens') || 0
  const cachedInputTokens = cacheCreationInputTokens + cacheReadInputTokens
  const totalInputTokens = inputTokens + cachedInputTokens
  const durationMs = numberField(toolResult, 'totalDurationMs') || fallbackDurationMs

  return {
    durationMs,
    agentActiveMs: durationMs,
    toolCalls: numberField(toolResult, 'totalToolUseCount'),
    tokensInput: totalInputTokens || undefined,
    tokensCachedInput: cachedInputTokens || undefined,
    tokensCacheCreationInput: cacheCreationInputTokens || undefined,
    tokensCacheReadInput: cacheReadInputTokens || undefined,
    tokensOutput: outputTokens || undefined,
    tokensTotal: numberField(toolResult, 'totalTokens') || totalInputTokens + outputTokens || undefined,
  }
}

function fileActivitiesFromClaudeToolUse(
  tool: string,
  input: Record<string, unknown>,
  ts: string,
  cwd: string | undefined,
): FileActivityRecord[] {
  const changes = new Map<string, FileActivityRecord>()
  const operation = operationForTool(tool)
  const workdir = stringField(input, 'cwd') || cwd

  for (const key of ['file_path', 'path', 'notebook_path']) {
    const filePath = stringField(input, key)
    if (!filePath) {
      continue
    }
    const metrics = fileMetricsFromClaudeToolInput(tool, input)
    addResolvedPathActivity(changes, filePath, operation, ts, cwd, workdir, metrics)
  }

  for (const edit of arrayField(input, 'edits')) {
    if (!isPlainObject(edit)) {
      continue
    }
    const filePath = stringField(input, 'file_path') || stringField(input, 'path')
    if (!filePath) {
      continue
    }
    addResolvedPathActivity(changes, filePath, 'edit', ts, cwd, workdir, {
      linesAdded: countTextLines(stringField(edit, 'new_string')),
      linesRemoved: countTextLines(stringField(edit, 'old_string')),
    })
  }

  const command = stringField(input, 'command')
  if (command) {
    for (const item of fileActivitiesFromShellCommand(command, ts, cwd, workdir)) {
      changes.set(item.path, mergeFileActivity(changes.get(item.path), item))
    }
  }

  return [...changes.values()]
}

function fileMetricsFromClaudeToolInput(
  tool: string,
  input: Record<string, unknown>,
): Partial<FileActivityRecord> {
  const normalized = tool.toLowerCase()
  if (normalized === 'read') {
    return { linesRead: numberField(input, 'limit') }
  }
  if (normalized === 'write') {
    const content = stringField(input, 'content')
    return {
      linesAdded: countTextLines(content),
      charsWritten: content?.length,
    }
  }
  if (normalized === 'edit' || normalized === 'multiedit') {
    const oldString = stringField(input, 'old_string')
    const newString = stringField(input, 'new_string')
    return {
      linesAdded: countTextLines(newString),
      linesRemoved: countTextLines(oldString),
      charsWritten: newString?.length,
    }
  }
  return {}
}

function arrayField(object: unknown, key: string): unknown[] {
  if (!isPlainObject(object) || !Array.isArray(object[key])) {
    return []
  }
  return object[key] as unknown[]
}

// ── Claude-specific content extraction (exported for hook dispatch) ──

export function claudeToolUseItems(message: Record<string, unknown>): Record<string, unknown>[] {
  return arrayField(message, 'content')
    .filter((item): item is Record<string, unknown> => isPlainObject(item) && item.type === 'tool_use')
}

export function claudeToolResultItems(message: Record<string, unknown>): Record<string, unknown>[] {
  return arrayField(message, 'content')
    .filter((item): item is Record<string, unknown> => isPlainObject(item) && item.type === 'tool_result')
}

export function isClaudeToolResultMessage(message: Record<string, unknown>): boolean {
  return claudeToolResultItems(message).length > 0
}

export function claudeTextStats(value: unknown): { chars?: number, hash?: string } {
  if (typeof value === 'string') {
    return {
      chars: value.length,
      hash: value ? `sha256:${createStableHash(value)}` : undefined,
    }
  }

  if (!Array.isArray(value)) {
    return { chars: undefined, hash: undefined }
  }

  const textItems = value
    .filter((item): item is Record<string, unknown> => isPlainObject(item) && item.type === 'text')
    .map(item => stringField(item, 'text') || '')
    .filter(Boolean)

  return {
    chars: textItems.reduce((total, item) => total + item.length, 0) || undefined,
    hash: textItems.length > 0 ? `sha256:${createStableHash(textItems)}` : undefined,
  }
}

// ── Claude-specific project/path helpers ──

async function claudeProjectContextFromLines(
  filePath: string,
  lines: string[],
  options: Record<string, unknown>,
): Promise<{ project?: string, workspaceId?: string }> {
  const projectDir = path.basename(path.dirname(filePath))
  const cwds: string[] = []
  for (const line of lines) {
    const raw = parseJsonLine(line)
    const cwd = raw ? stringField(raw, 'cwd') : undefined
    if (cwd && path.isAbsolute(cwd)) {
      cwds.push(cwd)
    }
  }

  const root = await gitRootFromCwds(cwds) || claudeProjectRootFromCwds(projectDir, cwds)
  const project = root ? path.basename(root) : claudeProjectFromFilePath(filePath, options)
  return {
    project,
    workspaceId: createWorkspaceId({ projectName: project, repoRoot: root }),
  }
}

async function gitRootFromCwds(cwds: string[]): Promise<string | undefined> {
  const seen = new Set<string>()
  for (const cwd of cwds) {
    let current = path.resolve(cwd)
    while (!seen.has(current)) {
      seen.add(current)
      try {
        await stat(path.join(current, '.git'))
        return current
      }
      catch { /* not a git repo here */ }
      const parent = path.dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
  }
  return undefined
}

function claudeProjectRootFromCwds(projectDir: string, cwds: string[]): string | undefined {
  for (const cwd of cwds) {
    let current = path.resolve(cwd)
    while (true) {
      if (encodeClaudeProjectPath(current) === projectDir) {
        return current
      }
      const parent = path.dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
  }
  return undefined
}

function encodeClaudeProjectPath(value: string): string {
  return path.resolve(value).split(path.sep).join('-')
}

function claudeProjectFromFilePath(filePath: string, options?: Record<string, unknown>): string | undefined {
  const projectDir = path.basename(path.dirname(filePath))
  const home = options
    ? path.resolve(stringOption(options.home) || os.homedir())
    : os.homedir()
  const homePrefix = `${encodeClaudeProjectPath(home)}-`
  if (projectDir.startsWith(homePrefix)) {
    return projectDir.slice(homePrefix.length) || undefined
  }
  return projectDir ? projectDir.replace(/^-+/, '') : undefined
}

// ── Installation ──

const claudeHandler = (msg: string) => hookHandler('claude', msg)

function hookConfig(): object {
  const anyTool = [{ matcher: '.*', hooks: [claudeHandler('Reporting tool activity')] }]

  return {
    hooks: {
      SessionStart: [{ hooks: [claudeHandler('Reporting session start')] }],
      SessionEnd: [{ hooks: [claudeHandler('Reporting session end')] }],
      UserPromptSubmit: [{ hooks: [claudeHandler('Reporting prompt activity')] }],
      PreToolUse: anyTool,
      PermissionRequest: anyTool,
      PermissionDenied: anyTool,
      PostToolUse: anyTool,
      PostToolUseFailure: anyTool,
      SubagentStart: [{ hooks: [claudeHandler('Reporting subagent start')] }],
      SubagentStop: [{ hooks: [claudeHandler('Reporting subagent completion')] }],
      Stop: [{ hooks: [claudeHandler('Reporting turn completion')] }],
      StopFailure: [{ hooks: [claudeHandler('Reporting turn failure')] }],
      PostCompact: [{ hooks: [claudeHandler('Reporting context compaction')] }],
    },
  }
}

// ── Adapter factory ──

// Resolve the effective Claude config directory. Claude Code uses
// CLAUDE_CONFIG_DIR to relocate the entire `.claude` tree (settings, projects,
// sessions); honor it so codetime can find sessions in non-default locations.
function claudeConfigDir(home: string, env?: AdapterEnv): string {
  const override = env?.CLAUDE_CONFIG_DIR
  if (override && override.trim()) {
    return path.resolve(override)
  }
  return path.join(home, '.claude')
}

export function createClaudeCodeAdapter(): AgentAdapter {
  return {
    id: 'claude-code',
    label: 'Claude Code',
    agentName: 'claude',
    kind: 'agent',

    detectPath(home: string, env?: AdapterEnv) {
      return claudeConfigDir(home, env)
    },
    installedPath(home: string, env?: AdapterEnv) {
      return path.join(claudeConfigDir(home, env), 'settings.json')
    },

    async isInstalled(home: string, env?: AdapterEnv) {
      return isHooksJsonInstalled(
        path.join(claudeConfigDir(home, env), 'settings.json'),
        'codetime hook --agent claude',
      )
    },

    installEntries(home: string, env?: AdapterEnv): InstallEntry[] {
      return [{
        kind: 'hooks-json',
        path: path.join(claudeConfigDir(home, env), 'settings.json'),
        content: hookConfig(),
      }]
    },

    sourcePaths(home: string, env?: AdapterEnv): string[] {
      const base = claudeConfigDir(home, env)
      // .claude.json (project trust/state) historically lived alongside the
      // home dir, but CLAUDE_CONFIG_DIR also relocates it.
      return [
        path.join(base, 'projects'),
        path.join(base, '.claude.json'),
        path.join(home, '.claude.json'),
      ]
    },

    parseSessionFile: parseClaudeCodeSessionFile,
  }
}
