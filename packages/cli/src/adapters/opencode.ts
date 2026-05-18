import type { CanonicalEvent, MetricBag } from '@codetime/shared'
import type { AdapterEnv, AgentAdapter, InstallEntry } from './types.js'
import os from 'node:os'
import path from 'node:path'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createStableHash,
  createWorkspaceId,
} from '@codetime/shared'
import { operationForTool, toolFileActivityType } from '../lib/activity.js'
import { matchesBackfillFilters } from '../lib/backfill.js'
import {
  isPlainObject,
  numberField,
  objectField,
  stringField,
  stringRefs,
} from '../lib/fields.js'
import { msToIso } from '../lib/jsonl.js'

interface OpenCodeUsage {
  tokensInput?: number
  tokensOutput?: number
  tokensReasoningOutput?: number
  tokensCachedInput?: number
  tokensCacheReadInput?: number
  tokensCacheCreationInput?: number
  tokensTotal: number
}

// ── Parser ──

async function parseOpenCodeSessionFile(
  dbPath: string,
  options: Record<string, unknown> & { _: string[] },
): Promise<CanonicalEvent[]> {
  const { DatabaseSync } = await import('node:sqlite')
  if (!dbPath.endsWith('.db')) {
    return []
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const events: CanonicalEvent[] = []

  try {
    const sessions = db.prepare(
      'SELECT id, directory, path, title, time_created, time_archived FROM session WHERE time_created IS NOT NULL ORDER BY time_created',
    ).all() as Array<{
      id: string
      directory: string | null
      path: string | null
      title: string
      time_created: number
      time_archived: number | null
    }>

    for (const session of sessions) {
      const sessionId = session.id
      const cwd = session.directory || session.path || undefined
      const project = cwd ? path.basename(cwd) : undefined

      const sessionTs = msToIso(session.time_created)
      events.push(baseOpenCodeEvent({
        ts: sessionTs,
        type: 'session.started',
        sessionId,
        cwd,
        project,
        operation: 'session start',
      }))

      const messages = db.prepare(
        'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created',
      ).all(sessionId) as Array<{ id: string, data: string }>

      let currentTurnId: string | undefined
      let turnTs: string | undefined

      for (const msg of messages) {
        let info: Record<string, unknown>
        try {
          info = JSON.parse(msg.data)
        }
        catch {
          continue
        }
        if (!isPlainObject(info)) {
          continue
        }

        const role = stringField(info, 'role')
        const timeObj = objectField(info, 'time')
        const timeCreated = numberField(timeObj, 'created')
        if (!role || !timeCreated) {
          continue
        }

        if (role === 'user') {
          currentTurnId = `turn_${createStableHash([sessionId, msg.id]).slice(0, 24)}`
          turnTs = msToIso(timeCreated)
          const userAgent = stringField(info, 'agent') || 'opencode'
          const modelObj = objectField(info, 'model')
          const model = modelObj ? stringField(modelObj, 'modelID') : undefined

          events.push(baseOpenCodeEvent({
            ts: turnTs,
            type: 'turn.started',
            sessionId,
            turnId: currentTurnId,
            cwd,
            project,
            model,
            operation: 'turn start',
            confidence: 'exact',
          }, userAgent))

          let promptText = ''
          try {
            const parts = db.prepare(
              'SELECT data FROM part WHERE message_id = ? ORDER BY id',
            ).all(msg.id) as Array<{ data: string }>
            for (const part of parts) {
              let pd: Record<string, unknown>
              try {
                pd = JSON.parse(part.data)
              }
              catch {
                continue
              }
              if (!isPlainObject(pd)) {
                continue
              }
              if (pd.type === 'text' && !pd.ignored && !pd.synthetic) {
                promptText += stringField(pd, 'text') || ''
              }
            }
          }
          catch { /* parts may not exist */ }

          if (promptText) {
            events.push(baseOpenCodeEvent({
              ts: turnTs,
              type: 'prompt.submitted',
              sessionId,
              turnId: currentTurnId,
              cwd,
              project,
              model,
              operation: 'prompt submitted',
              confidence: 'exact',
              metrics: { prompts: 1, promptChars: promptText.length },
              refs: stringRefs({ promptHash: `sha256:${createStableHash(promptText)}` }),
            }, userAgent))
          }
        }

        if (role === 'assistant') {
          const model = stringField(info, 'modelID')
          const assistantAgent = stringField(info, 'agent') || 'opencode'
          const pathObj = objectField(info, 'path')
          const assistantCwd = stringField(pathObj, 'cwd') || cwd
          const assistantProject = assistantCwd ? path.basename(assistantCwd) : project
          const completedTs = numberField(objectField(info, 'time'), 'completed')
          const createdTs = timeCreated

          const tokens = opencodeUsageFromInfo(info)
          const cost = (typeof info.cost === 'number' && info.cost > 0) ? info.cost as number : undefined

          if (tokens) {
            const metrics: MetricBag = {
              tokensInput: tokens.tokensInput,
              tokensOutput: tokens.tokensOutput,
              tokensReasoningOutput: tokens.tokensReasoningOutput,
              tokensCachedInput: tokens.tokensCachedInput,
              tokensCacheReadInput: tokens.tokensCacheReadInput,
              tokensCacheCreationInput: tokens.tokensCacheCreationInput,
              tokensTotal: tokens.tokensTotal,
            }
            if (cost !== undefined) {
              metrics.costUsd = cost
            }
            events.push(baseOpenCodeEvent({
              ts: msToIso(completedTs || createdTs),
              type: 'model.usage',
              sessionId,
              turnId: currentTurnId,
              cwd: assistantCwd,
              project: assistantProject,
              model,
              operation: 'model usage',
              metrics,
            }, assistantAgent))
          }

          try {
            const parts = db.prepare(
              'SELECT data FROM part WHERE message_id = ? ORDER BY id',
            ).all(msg.id) as Array<{ data: string }>
            for (const part of parts) {
              let pd: Record<string, unknown>
              try {
                pd = JSON.parse(part.data)
              }
              catch {
                continue
              }
              if (!isPlainObject(pd)) {
                continue
              }

              if (pd.type === 'tool') {
                const tool = stringField(pd, 'tool') || 'unknown'
                const callId = stringField(pd, 'callID')
                const state = objectField(pd, 'state')
                const status = stringField(state, 'status')
                const stateTime = objectField(state, 'time')
                const startMs = numberField(stateTime, 'start') || createdTs
                const endMs = numberField(stateTime, 'end')
                const stateInput = objectField(state, 'input')

                events.push(baseOpenCodeEvent({
                  ts: msToIso(startMs),
                  type: 'tool.started',
                  sessionId,
                  turnId: currentTurnId,
                  cwd: assistantCwd,
                  project: assistantProject,
                  model,
                  tool,
                  operation: `${tool} started`,
                  metrics: { toolCalls: 1 },
                  refs: stringRefs({ sourceId: callId }),
                }, assistantAgent))

                if (status === 'completed' || status === 'error') {
                  const durationMs = endMs && startMs ? endMs - startMs : undefined
                  const success = status === 'completed'

                  events.push(baseOpenCodeEvent({
                    ts: msToIso(endMs || completedTs || createdTs),
                    type: success ? 'tool.completed' : 'tool.failed',
                    sessionId,
                    turnId: currentTurnId,
                    cwd: assistantCwd,
                    project: assistantProject,
                    model,
                    tool,
                    success,
                    operation: success ? `${tool} completed` : `${tool} failed`,
                    metrics: { toolDurationMs: durationMs, durationMs },
                    refs: stringRefs({ sourceId: callId }),
                  }, assistantAgent))

                  if (tool === 'bash' || tool === 'Bash') {
                    const command = stringField(stateInput, 'command')
                    events.push(baseOpenCodeEvent({
                      ts: msToIso(endMs || completedTs || createdTs),
                      type: success ? 'command.completed' : 'command.failed',
                      sessionId,
                      turnId: currentTurnId,
                      cwd: assistantCwd,
                      project: assistantProject,
                      model,
                      tool: 'Bash',
                      success,
                      operation: success ? 'command completed' : 'command failed',
                      metrics: { commandCalls: 1, commandDurationMs: durationMs, durationMs },
                      refs: stringRefs({
                        sourceId: callId,
                        commandHash: command ? `sha256:${createStableHash(String(command))}` : undefined,
                      }),
                    }, assistantAgent))
                  }

                  const filePath = stringField(stateInput, 'file_path') || stringField(stateInput, 'filePath')
                  if (filePath) {
                    events.push(baseOpenCodeEvent({
                      ts: msToIso(endMs || completedTs || createdTs),
                      type: toolFileActivityType(tool),
                      sessionId,
                      turnId: currentTurnId,
                      cwd: assistantCwd,
                      project: assistantProject,
                      model,
                      tool,
                      success,
                      operation: `${tool} file activity`,
                      fileActivities: [{
                        ts: msToIso(endMs || completedTs || createdTs),
                        path: filePath,
                        operation: operationForTool(tool),
                      }],
                      refs: stringRefs({ sourceId: callId }),
                    }, assistantAgent))
                  }
                }
              }

              if (pd.type === 'step-finish') {
                const stepTokens = opencodeUsageFromInfo(pd)
                const stepCost = (typeof pd.cost === 'number' && pd.cost > 0) ? pd.cost as number : undefined
                if (stepTokens) {
                  const stepMetrics: MetricBag = {
                    tokensInput: stepTokens.tokensInput,
                    tokensOutput: stepTokens.tokensOutput,
                    tokensReasoningOutput: stepTokens.tokensReasoningOutput,
                    tokensCachedInput: stepTokens.tokensCachedInput,
                    tokensCacheReadInput: stepTokens.tokensCacheReadInput,
                    tokensCacheCreationInput: stepTokens.tokensCacheCreationInput,
                    tokensTotal: stepTokens.tokensTotal,
                  }
                  if (stepCost !== undefined) {
                    stepMetrics.costUsd = stepCost
                  }
                  events.push(baseOpenCodeEvent({
                    ts: msToIso(completedTs || createdTs),
                    type: 'model.usage',
                    sessionId,
                    turnId: currentTurnId,
                    cwd: assistantCwd,
                    project: assistantProject,
                    model,
                    operation: 'model usage (step)',
                    confidence: 'exact',
                    metrics: stepMetrics,
                  }, assistantAgent))
                }
              }

              if (pd.type === 'subtask') {
                events.push(baseOpenCodeEvent({
                  ts: msToIso(createdTs),
                  type: 'subagent.started',
                  sessionId,
                  turnId: currentTurnId,
                  cwd: assistantCwd,
                  project: assistantProject,
                  model,
                  operation: 'subagent started',
                  agentInstanceId: stringField(pd, 'agent') || stringField(pd, 'description'),
                }, assistantAgent))
              }
            }
          }
          catch { /* parts may not exist */ }

          if (stringField(info, 'finish')) {
            const durationMs = completedTs && createdTs ? completedTs - createdTs : undefined
            events.push(baseOpenCodeEvent({
              ts: msToIso(completedTs || createdTs),
              type: 'turn.completed',
              sessionId,
              turnId: currentTurnId,
              cwd: assistantCwd,
              project: assistantProject,
              model,
              operation: 'turn completed',
              metrics: { durationMs },
            }, assistantAgent))
          }
        }
      }

      if (session.time_archived) {
        events.push(baseOpenCodeEvent({
          ts: msToIso(session.time_archived),
          type: 'session.ended',
          sessionId,
          cwd,
          project,
          operation: 'session end',
        }))
      }
    }
  }
  finally {
    db.close()
  }

  return events.filter(event => matchesBackfillFilters(event, options))
}

// ── OpenCode-specific helpers ──

function baseOpenCodeEvent(
  event: Omit<CanonicalEvent, 'schemaVersion' | 'source' | 'agent' | 'workspaceId' | 'confidence'>
    & { confidence?: CanonicalEvent['confidence'] },
  agentName?: string,
): CanonicalEvent {
  return {
    schemaVersion: AGENT_TIME_SCHEMA_VERSION,
    source: 'opencode',
    agent: agentName || 'opencode',
    workspaceId: createWorkspaceId({ projectName: event.project, repoRoot: event.cwd }),
    ...event,
  }
}

function opencodeUsageFromInfo(info: Record<string, unknown>): OpenCodeUsage | undefined {
  const tokensObj = objectField(info, 'tokens')
  if (!tokensObj) {
    return undefined
  }
  const input = Math.max(0, numberField(tokensObj, 'input') || 0)
  const output = Math.max(0, numberField(tokensObj, 'output') || 0)
  const reasoning = Math.max(0, numberField(tokensObj, 'reasoning') || 0)
  const cache = objectField(tokensObj, 'cache')
  const cacheRead = Math.max(0, numberField(cache, 'read') || 0)
  const cacheWrite = Math.max(0, numberField(cache, 'write') || 0)
  const totalInput = input + cacheRead + cacheWrite
  const total = Math.max(0, numberField(tokensObj, 'total') || (totalInput + output + reasoning))
  if (total <= 0) {
    return undefined
  }
  return {
    tokensInput: totalInput || undefined,
    tokensOutput: output || undefined,
    tokensReasoningOutput: reasoning || undefined,
    tokensCachedInput: (cacheRead + cacheWrite) || undefined,
    tokensCacheReadInput: cacheRead || undefined,
    tokensCacheCreationInput: cacheWrite || undefined,
    tokensTotal: total,
  }
}

// ── Path resolution ──

// OpenCode follows XDG for its config (~/.config/opencode) and data
// (~/.local/share/opencode), but also reads OPENCODE_CONFIG_DIR for the former.
// Both can move independently — agents, plugins, and history.

function opencodeConfigDir(home: string, env?: AdapterEnv): string {
  const override = env?.OPENCODE_CONFIG_DIR
  if (override && override.trim()) {
    return path.resolve(override)
  }
  const xdgConfig = env?.XDG_CONFIG_HOME
  if (xdgConfig && xdgConfig.trim()) {
    return path.join(path.resolve(xdgConfig), 'opencode')
  }
  return path.join(home, '.config', 'opencode')
}

function opencodeDataCandidates(home: string, env?: AdapterEnv): string[] {
  const xdgData = env?.XDG_DATA_HOME
  const primary = xdgData && xdgData.trim()
    ? path.join(path.resolve(xdgData), 'opencode', 'opencode.db')
    : path.join(home, '.local', 'share', 'opencode', 'opencode.db')
  // Keep the legacy ~/.opencode/opencode.db location as a fallback for older
  // installs that haven't migrated to the XDG data dir.
  return [primary, path.join(home, '.opencode', 'opencode.db')]
}

// ── Backfill file discovery (special: OpenCode uses SQLite, not JSONL) ──

export async function opencodeBackfillFiles(
  sourceRoot?: string,
  home: string = os.homedir(),
  env?: AdapterEnv,
): Promise<Array<{ path: string, modifiedAt: string }>> {
  const { stat } = await import('node:fs/promises')
  if (sourceRoot) {
    if (!sourceRoot.endsWith('.db')) {
      return []
    }
    const info = await stat(sourceRoot).catch(() => null)
    if (!info) {
      return []
    }
    return [{ path: sourceRoot, modifiedAt: info.mtime.toISOString() }]
  }

  for (const candidatePath of opencodeDataCandidates(home, env)) {
    const info = await stat(candidatePath).catch(() => null)
    if (info) {
      return [{ path: candidatePath, modifiedAt: info.mtime.toISOString() }]
    }
  }
  return []
}

// ── Installation content ──

function opencodePluginContent(): string {
  return `// Agent Time plugin for OpenCode
// Generated by codetime.

export const AgentTime = async ({ $, directory }) => {
  const report = async (payload) => {
    try {
      await $\`codetime hook --agent opencode\`.stdin(JSON.stringify(payload)).quiet()
    } catch {}
  }

  return {
    "session.created": async (ctx) => {
      await report({
        hook_event_name: "SessionStart",
        session_id: ctx?.id,
        cwd: directory
      })
    },
    "session.idle": async (ctx) => {
      await report({
        hook_event_name: "SessionEnd",
        session_id: ctx?.id,
        cwd: directory
      })
    },
    "tool.execute.after": async (input) => {
      const toolName = input?.tool || "unknown"
      const toolCallId = input?.toolCallId
      const toolInput = input?.args || input?.input || {}
      const command = toolInput?.command
      const filePath = toolInput?.file_path || toolInput?.filePath

      await report({
        hook_event_name: "PostToolUse",
        tool_name: toolName,
        tool_use_id: toolCallId,
        cwd: directory,
        tool_input: { command, file_path: filePath }
      })
    }
  }
}
`
}

// ── Adapter factory ──

export function createOpenCodeAdapter(): AgentAdapter {
  const PLUGIN_PATH = 'plugins/codetime.mjs'

  return {
    id: 'opencode',
    label: 'OpenCode',
    agentName: 'opencode',
    kind: 'agent',

    detectPath(home: string, env?: AdapterEnv) {
      return opencodeConfigDir(home, env)
    },
    installedPath(home: string, env?: AdapterEnv) {
      return path.join(opencodeConfigDir(home, env), PLUGIN_PATH)
    },

    async isInstalled(home: string, env?: AdapterEnv) {
      try {
        const { pathExists } = await import('../lib/fs.js')
        return await pathExists(path.join(opencodeConfigDir(home, env), PLUGIN_PATH))
          || await pathExists(path.join('.opencode', PLUGIN_PATH))
      }
      catch {
        return false
      }
    },

    installEntries(home: string, env?: AdapterEnv): InstallEntry[] {
      return [{
        kind: 'file',
        path: path.join(opencodeConfigDir(home, env), PLUGIN_PATH),
        content: opencodePluginContent(),
      }]
    },

    sourcePaths(home: string, env?: AdapterEnv): string[] {
      return opencodeDataCandidates(home, env)
    },

    parseSessionFile: parseOpenCodeSessionFile,
  }
}
