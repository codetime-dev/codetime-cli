import type { CanonicalEvent } from '@codetime/shared'
import type { AdapterEnv, AgentAdapter, InstallEntry } from './types.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
// Codex's fast/priority service_tier costs ~2× standard, so we encode the tier
// into the model name (e.g. `gpt-5-codex-fast`) so the backend pricing table
// resolves to the tier-specific entry. We only trust per-turn evidence inside
// the session file itself — never the current `config.toml`. The old behavior
// (read CODEX_HOME/config.toml once, stamp every historical model.usage with
// `-fast`) caused false positives whenever a user enabled fast later, because
// every old session would be retroactively re-classified on the next backfill.
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
  // Headless `codex exec` files have no session_meta; emit a synthetic
  // session.started on the first usage line so rollups still get a boundary.
  let sessionStartEmitted = false
  // Per-turn service tier. Updated whenever a turn_context (or future per-turn
  // event) carries an explicit service_tier; never inferred from config.toml.
  let serviceTier: string | undefined
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
  // Forked subagent rollouts (session_meta.source.subagent.thread_spawn) begin by
  // REPLAYING the parent session's entire token history, all re-stamped at the
  // subagent's creation second. The lastTokenUsageKey dedup above only catches
  // *consecutive identical* records within a file — it cannot catch this replay,
  // whose cumulative counts differ line to line, so the parent's usage (cached
  // input especially) was being counted once per subagent file and inflating
  // totals several-fold. Detect the replay block up front and skip its leading
  // run of token_count events. Mirrors ccusage detect_subagent_replay_second
  // (adapter/codex/parser.rs).
  const replaySecond = detectSubagentReplaySecond(text, lines)
  let skipReplay = replaySecond !== undefined
  // Running cumulative baseline. Some Codex builds emit token_count events that
  // carry only info.total_token_usage (a cumulative), with no per-turn
  // last_token_usage. For those we derive the turn's usage as current-minus-previous
  // cumulative — so we must track the last cumulative we saw. Mirrors ccusage's
  // previous_totals in subtract_codex_raw_usage.
  let previousTotals: CodexCumulative = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 }
  const pendingToolCalls = new Map<string, { tool: string, startedAt: string, turnId: string | undefined }>()
  // Per-turn last activity timestamp and turn start timestamp. When we close a
  // turn implicitly (next user_message, or EOF fallback), turn.completed must
  // carry that turn's OWN last activity ts — never the new prompt's ts or the
  // global last event ts — so idle time between turns isn't counted as duration.
  const turnLastEventAt = new Map<string, string>()
  const turnStartedAt = new Map<string, string>()
  // Turns already closed by an explicit task_complete. The user_message branch
  // and the EOF fallback must not emit a second turn.completed for these.
  const closedTurnIds = new Set<string>()

  // Push an event and, when it belongs to a turn, advance that turn's last
  // activity timestamp (and record its start the first time we see it).
  const pushEvent = (event: CanonicalEvent, refs: Parameters<typeof withBackfillRefs>[1]): void => {
    const turnId = event.turnId
    if (turnId && event.ts) {
      if (!turnStartedAt.has(turnId)) {
        turnStartedAt.set(turnId, event.ts)
      }
      const prev = turnLastEventAt.get(turnId)
      if (!prev || event.ts > prev) {
        turnLastEventAt.set(turnId, event.ts)
      }
    }
    events.push(withBackfillRefs(event, refs))
  }

  // Best-effort last activity ts for a turn (fallback: its start, then a fresh now).
  const turnCloseTs = (turnId: string): string =>
    turnLastEventAt.get(turnId) || turnStartedAt.get(turnId) || new Date().toISOString()

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
      sessionStartEmitted = true
      continue
    }

    if (topType === 'turn_context') {
      currentTurnId = stringField(payload, 'turn_id') || currentTurnId
      cwd = stringField(payload, 'cwd') || cwd
      project = cwd ? path.basename(cwd) : project
      model = stringField(payload, 'model') || model
      // Codex hasn't shipped service_tier inside turn_context yet, but the field
      // is the natural per-turn location and the upstream protocol allows it.
      // Honor it when present so future Codex builds get accurate fast/priority
      // attribution without another parser change.
      const tier = stringField(payload, 'service_tier')
      if (tier) {
        serviceTier = tier.toLowerCase()
      }
      continue
    }

    // Headless `codex exec` output: turn.completed / result / bare {data:{usage}}
    // lines carry usage directly, with no session_meta/event_msg wrapper.
    // Mirrors ccusage's headless parser (adapter/codex/parser.rs).
    if (topType === 'turn.completed' || topType === 'result' || topType === undefined) {
      const usage = headlessCodexUsage(raw)
      if (usage) {
        const parsedModel = headlessCodexModel(raw)
        if (parsedModel) {
          model = parsedModel
        }
        const eventModel = parsedModel || model || 'gpt-5'
        const headlessTs = headlessCodexTimestamp(raw) || ts
        if (!sessionStartEmitted) {
          pushEvent(baseCodexEvent({
            ts: headlessTs,
            type: 'session.started',
            sessionId,
            model: eventModel,
            confidence: 'derived',
          }), { filePath, sourcePathHash, lineNumber, topType: topType || 'result', payloadType: 'session', options })
          sessionStartEmitted = true
        }
        pushEvent(baseCodexEvent({
          ts: headlessTs,
          type: 'model.usage',
          sessionId,
          model: eventModel,
          confidence: 'partial',
          metrics: usage,
        }), { filePath, sourcePathHash, lineNumber, topType: topType || 'result', payloadType: 'headless', options })
      }
      continue
    }

    if (topType !== 'event_msg' && topType !== 'response_item') {
      continue
    }

    switch (payloadType) {
      case 'task_started': {
        currentTurnId = stringField(payload, 'turn_id') || currentTurnId
        pushEvent(baseCodexEvent({
          ts,
          type: 'turn.started',
          sessionId,
          turnId: currentTurnId,
          cwd,
          project,
          model,
          confidence: 'exact',
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })

        break
      }
      case 'user_message': {
        const message = stringField(payload, 'message') || ''
        // Close previous turn before starting a new one. Use that turn's OWN last
        // activity ts (not this prompt's ts), and skip turns already closed by an
        // explicit task_complete so we never emit a duplicate turn.completed.
        if (
          currentTurnId && currentTurnId !== turnIdAtLastUserMessage
          && lastTurnIdForComplete && !closedTurnIds.has(lastTurnIdForComplete)
        ) {
          closedTurnIds.add(lastTurnIdForComplete)
          pushEvent(baseCodexEvent({
            ts: turnCloseTs(lastTurnIdForComplete),
            type: 'turn.completed',
            sessionId,
            turnId: lastTurnIdForComplete,
            cwd,
            project,
            model,
            confidence: 'derived',
          }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })
        }
        if (!currentTurnId || currentTurnId === turnIdAtLastUserMessage) {
          currentTurnId = `turn_${createStableHash([sessionId, lineNumber, ts]).slice(0, 24)}`
        }
        lastTurnIdForComplete = currentTurnId
        turnIdAtLastUserMessage = currentTurnId
        pushEvent(baseCodexEvent({
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
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })

        break
      }
      case 'token_count': {
        // Some Codex builds carry service_tier alongside last_token_usage, so
        // pick it up here too as a secondary per-turn signal.
        const info = objectField(payload, 'info')
        const tierFromInfo = stringField(info, 'service_tier') || stringField(payload, 'service_tier')
        if (tierFromInfo) {
          serviceTier = tierFromInfo.toLowerCase()
        }
        // Per-turn usage: prefer last_token_usage; otherwise derive the delta from
        // the cumulative total_token_usage minus the running baseline, so token_count
        // events that carry only a cumulative total are counted instead of dropped.
        const totalUsage = objectField(info, 'total_token_usage')
        const hasTotal = Object.keys(totalUsage).length > 0
        const usage = tokenUsageFromPayload(payload)
          ?? (hasTotal ? codexUsageDelta(totalUsage, previousTotals, info) : undefined)
        // Advance the baseline from every total_token_usage we see — including
        // replayed events we skip — so the first real event's delta is measured
        // against the right prior cumulative.
        if (hasTotal) {
          previousTotals = readCodexCumulative(totalUsage)
        }
        if (usage) {
          // Drop the leading run of replayed parent-history token_count events in a
          // forked subagent rollout (all stamped at the replay second). The first
          // event at a later second is the subagent's own usage and ends the skip.
          if (skipReplay) {
            if (ts.slice(0, 19) === replaySecond) {
              break
            }
            skipReplay = false
          }
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
          pushEvent(baseCodexEvent({
            ts,
            type: 'model.usage',
            sessionId,
            turnId: currentTurnId,
            cwd,
            project,
            // Only the model.usage event carries the -fast suffix; tool and
            // turn events keep the bare model so other queries (e.g. "what
            // model was the user on") don't show tier-specific names.
            model: rewriteCodexModelForTier(model, serviceTier),
            confidence: 'partial',
            metrics: usage,
          }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })
        }

        break
      }
      case 'agent_message': {
        const message = stringField(payload, 'message') || ''
        pushEvent(baseCodexEvent({
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
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })

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

        pushEvent(baseCodexEvent({
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
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })
        if (fileActivities.length > 0) {
          pushEvent(baseCodexEvent({
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
          }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })
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

        pushEvent(baseCodexEvent({
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
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })

        break
      }
      case 'exec_command_end': {
        const durationMs = durationObjectToMs(objectField(payload, 'duration'))
        const success = Number(payload.exit_code) === 0
        pushEvent(baseCodexEvent({
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
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })

        break
      }
      case 'patch_apply_end': {
        const fileActivities = fileActivitiesFromPatchChanges(
          objectField(payload, 'changes'),
          ts,
          cwd,
          displayFilePath,
        )
        pushEvent(baseCodexEvent({
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
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })

        break
      }
      case 'task_complete': {
        // task_complete's own ts is correct, so leave it as-is. Record the turn as
        // closed so the user_message / EOF fallbacks don't re-emit turn.completed.
        const completedTurnId = stringField(payload, 'turn_id') || currentTurnId
        if (completedTurnId) {
          closedTurnIds.add(completedTurnId)
        }
        pushEvent(baseCodexEvent({
          ts,
          type: 'turn.completed',
          sessionId,
          turnId: completedTurnId,
          cwd,
          project,
          model,
          confidence: 'exact',
          metrics: {
            durationMs: numberField(payload, 'duration_ms'),
          },
        }), { filePath, sourcePathHash, lineNumber, topType, payloadType, options })

        break
      }
    // No default
    }
  }

  // Close the last turn if no task_complete already closed it. Use that turn's own
  // last activity ts (not the global last event ts, which may belong to a later,
  // separately-tracked turn).
  if (lastTurnIdForComplete && !closedTurnIds.has(lastTurnIdForComplete)) {
    closedTurnIds.add(lastTurnIdForComplete)
    pushEvent(baseCodexEvent({
      ts: turnCloseTs(lastTurnIdForComplete),
      type: 'turn.completed',
      sessionId,
      turnId: lastTurnIdForComplete,
      cwd,
      project,
      model,
      confidence: 'derived',
    }), { filePath, sourcePathHash, lineNumber: lines.length, topType: 'event_msg', payloadType: 'turn.completed', options })
  }

  return events.filter(event => validateCanonicalEvent(event).valid)
}

// ── Codex-specific helpers ──

function rewriteCodexModelForTier(model: string | undefined, serviceTier: string | undefined): string | undefined {
  if (!model) {
    return model
  }
  const isFastTier = serviceTier === 'fast' || serviceTier === 'priority'
  return isFastTier ? `${model}-fast` : model
}

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

// ── Headless codex exec (turn.completed / result / bare data.usage) ──

// Pull usage from the top-level object or a nested data/result/response wrapper,
// honoring the field aliases ccusage accepts (prompt/completion/cached_tokens).
function headlessCodexUsage(raw: Record<string, unknown>) {
  const usage = [
    objectField(raw, 'usage'),
    objectField(objectField(raw, 'data'), 'usage'),
    objectField(objectField(raw, 'result'), 'usage'),
    objectField(objectField(raw, 'response'), 'usage'),
  ].find(candidate => Object.keys(candidate).length > 0)
  if (!usage) {
    return
  }

  const input = numberField(usage, 'input_tokens') ?? numberField(usage, 'prompt_tokens') ?? 0
  const output = numberField(usage, 'output_tokens') ?? numberField(usage, 'completion_tokens') ?? 0
  const cached = numberField(usage, 'cached_input_tokens')
    ?? numberField(usage, 'cache_read_input_tokens')
    ?? numberField(usage, 'cached_tokens')
    ?? 0
  const reasoning = numberField(usage, 'reasoning_output_tokens') ?? numberField(usage, 'reasoning_tokens') ?? 0
  const totalField = numberField(usage, 'total_tokens')
  // ccusage keeps total_tokens only when positive (or everything is zero),
  // otherwise recomputes from input+output+reasoning — cache is NOT added.
  const total = totalField !== undefined && (totalField > 0 || input + output + reasoning === 0)
    ? totalField
    : input + output + reasoning

  if (input === 0 && cached === 0 && output === 0 && reasoning === 0 && total === 0) {
    return
  }

  // Headless (codex exec) reports output_tokens EXCLUSIVE of reasoning — ccusage's
  // total recompute (input + output + reasoning) only makes sense if reasoning is
  // not already inside output. Fold reasoning into tokensOutput (billable-output
  // convention); tokensReasoningOutput stays as the informational subset. The
  // recomputed total above is unchanged: input + output + reasoning == input +
  // (output + reasoning), so it already equals input + foldedOutput.
  const billableOutput = output + reasoning

  return {
    tokensInput: input || undefined,
    // Clamp cached to input so non-cached (input - cached) never goes negative
    // (ccusage cached.min(input) in the headless path too).
    tokensCachedInput: Math.min(cached, input) || undefined,
    tokensOutput: billableOutput || undefined,
    tokensReasoningOutput: reasoning || undefined,
    tokensTotal: total,
    modelCalls: 1,
  }
}

function headlessCodexModel(raw: Record<string, unknown>): string | undefined {
  for (const source of [raw, objectField(raw, 'data'), objectField(raw, 'result'), objectField(raw, 'response')]) {
    const model = stringField(source, 'model') ?? stringField(source, 'model_name')
    if (model) {
      return model
    }
  }
  return undefined
}

function headlessCodexTimestamp(raw: Record<string, unknown>): string | undefined {
  const data = objectField(raw, 'data')
  const result = objectField(raw, 'result')
  const response = objectField(raw, 'response')
  for (const source of [raw, data, result, response]) {
    const ts = timestampFrom(source.timestamp)
      ?? timestampFrom(source.created_at)
      ?? timestampFrom(source.createdAt)
    if (ts) {
      return ts
    }
  }
  return undefined
}

// Codex spawns a subagent into its own rollout file that opens by replaying the
// parent session's token history, re-stamped at the subagent's creation second.
// Return that second when this file is such a replay so the parser can drop the
// leading token_count run stamped at it. A file qualifies only when it carries the
// thread_spawn marker AND its first two usage-bearing token_count events share one
// second (the tell-tale of a re-stamped replay block). Returns undefined otherwise
// — including single-token_count files, where there is nothing to disambiguate.
// Mirrors ccusage is_codex_subagent_session + detect_subagent_replay_second.
function detectSubagentReplaySecond(text: string, lines: string[]): string | undefined {
  if (!text.includes('thread_spawn')) {
    return undefined
  }
  let firstSecond: string | undefined
  for (const line of lines) {
    const raw = parseJsonLine(line)
    if (!raw || stringField(raw, 'type') !== 'event_msg') {
      continue
    }
    const payload = objectField(raw, 'payload')
    if (stringField(payload, 'type') !== 'token_count') {
      continue
    }
    const info = objectField(payload, 'info')
    const hasUsage = Object.keys(objectField(info, 'last_token_usage')).length > 0
      || Object.keys(objectField(info, 'total_token_usage')).length > 0
    if (!hasUsage) {
      continue
    }
    const ts = timestampFrom(raw.timestamp) || timestampFrom(payload.timestamp)
    if (!ts) {
      continue
    }
    const second = ts.slice(0, 19)
    if (firstSecond === undefined) {
      firstSecond = second
    }
    else {
      return firstSecond === second ? firstSecond : undefined
    }
  }
  return undefined
}

export function tokenUsageFromPayload(payload: Record<string, unknown>) {
  const info = objectField(payload, 'info')
  const usage = objectField(info, 'last_token_usage')
  if (Object.keys(usage).length === 0) {
    return
  }

  const input = numberField(usage, 'input_tokens')
  const cached = numberField(usage, 'cached_input_tokens')
  return {
    tokensInput: input,
    // Cached input can never exceed total input; clamp so the server's
    // non-cached = input - cached never goes negative (ccusage cached.min(input)).
    tokensCachedInput: cached === undefined ? undefined : Math.min(cached, input ?? 0),
    tokensOutput: numberField(usage, 'output_tokens'),
    tokensReasoningOutput: numberField(usage, 'reasoning_output_tokens'),
    tokensTotal: numberField(usage, 'total_tokens'),
    modelContextWindow: numberField(info, 'model_context_window'),
  }
}

interface CodexCumulative { input: number, cached: number, output: number, reasoning: number, total: number }

function readCodexCumulative(usage: Record<string, unknown>): CodexCumulative {
  return {
    input: numberField(usage, 'input_tokens') ?? 0,
    cached: numberField(usage, 'cached_input_tokens') ?? 0,
    output: numberField(usage, 'output_tokens') ?? 0,
    reasoning: numberField(usage, 'reasoning_output_tokens') ?? 0,
    total: numberField(usage, 'total_tokens') ?? 0,
  }
}

// Per-turn delta from a cumulative total_token_usage minus the prior cumulative
// baseline (ccusage subtract_codex_raw_usage). Returns undefined when the delta is
// entirely zero (e.g. a repeated cumulative) so no empty usage event is emitted.
function codexUsageDelta(
  totalUsage: Record<string, unknown>,
  previous: CodexCumulative,
  info: Record<string, unknown>,
) {
  const cur = readCodexCumulative(totalUsage)
  const input = Math.max(0, cur.input - previous.input)
  const cached = Math.max(0, cur.cached - previous.cached)
  const output = Math.max(0, cur.output - previous.output)
  const reasoning = Math.max(0, cur.reasoning - previous.reasoning)
  const total = Math.max(0, cur.total - previous.total)
  if (input === 0 && cached === 0 && output === 0 && reasoning === 0 && total === 0) {
    return
  }
  return {
    tokensInput: input || undefined,
    tokensCachedInput: Math.min(cached, input) || undefined,
    tokensOutput: output || undefined,
    tokensReasoningOutput: reasoning || undefined,
    tokensTotal: total || undefined,
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

// Codex relocates its entire data dir via CODEX_HOME (config.toml, auth.json,
// sessions/, history.jsonl). Honor it for both install and backfill paths.
function codexHome(home: string, env?: AdapterEnv): string {
  const override = env?.CODEX_HOME
  if (override && override.trim()) {
    return path.resolve(override)
  }
  return path.join(home, '.codex')
}

export function createCodexAdapter(): AgentAdapter {
  return {
    id: 'codex',
    label: 'Codex',
    agentName: 'codex',
    kind: 'agent',

    detectPath(home: string, env?: AdapterEnv) {
      return codexHome(home, env)
    },
    installedPath(home: string, env?: AdapterEnv) {
      return path.join(codexHome(home, env), 'hooks.json')
    },

    async isInstalled(home: string, env?: AdapterEnv) {
      return isHooksJsonInstalled(
        path.join(codexHome(home, env), 'hooks.json'),
        'codetime hook --agent codex',
      )
    },

    installEntries(home: string, env?: AdapterEnv): InstallEntry[] {
      return [{
        kind: 'hooks-json',
        path: path.join(codexHome(home, env), 'hooks.json'),
        content: hookConfig(),
      }]
    },

    sourcePaths(home: string, env?: AdapterEnv): string[] {
      const base = codexHome(home, env)
      return [
        path.join(base, 'sessions'),
        path.join(base, 'history.jsonl'),
      ]
    },

    parseSessionFile: parseCodexSessionFile,
  }
}
