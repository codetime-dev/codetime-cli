import type { CanonicalEvent } from '@codetime/shared'
import type { AdapterEnv, AgentAdapter, InstallEntry } from './types.js'
import { readFile, stat } from 'node:fs/promises'
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
import { listJsonlFiles } from '../lib/fs.js'
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
  // `session_meta` has no model — only `model_provider` — so seed from the
  // first `turn_context` up front. See firstCodexTurnContextModel.
  let model: string | undefined = firstCodexTurnContextModel(lines)
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
  // Forked rollouts (subagent thread_spawn, branch/goal/resume forks) begin by
  // REPLAYING the parent session's entire token history. The lastTokenUsageKey
  // dedup above only catches *consecutive identical* records within a file — it
  // cannot catch this replay, whose cumulative counts differ line to line, so the
  // parent's usage (cached input especially) was being counted once per forked
  // file and inflating totals several-fold.
  //
  // Codex copies the token counts verbatim but rewrites the timestamps, so match
  // the leading usage against the parent's own stream and drop what lines up. The
  // older same-second heuristic only held when the whole replay burst landed in
  // one second — it missed long replays and nested forks. It stays as the fallback
  // for when the parent log is unavailable or the copied history was compacted and
  // no longer starts at the parent's first event. Mirrors ccusage CodexReplayPlan
  // + detect_replay_second (adapter/codex/replay.rs, parser.rs).
  const replaySecond = detectSubagentReplaySecond(text, lines)
  const replayPrefix = await codexReplayPrefix(filePath, lines)
  let replay: { kind: 'matching', index: number } | { kind: 'second' } | { kind: 'done' }
    = replayPrefix === undefined
      ? (replaySecond === undefined ? { kind: 'done' } : { kind: 'second' })
      : { kind: 'matching', index: 0 }

  // Whether a usage event is the rollout's own rather than replayed history.
  // Each arm either returns or advances the state toward 'done', so the loop only
  // re-runs to apply the event to the state it switched to.
  const admitReplayedUsage = (usageKey: string, eventTs: string): boolean => {
    for (;;) {
      if (replay.kind === 'matching') {
        if ((replayPrefix ?? [])[replay.index] === usageKey) {
          replay = { kind: 'matching', index: replay.index + 1 }
          return false
        }
        // Nothing matched, so the parent stream cannot anchor this replay: the log
        // is unavailable, or Codex rewrote the copied history. Fall back to the
        // rewritten-second burst — but only when not a single event lined up,
        // since a mid-prefix break means the child's own usage has started.
        replay = replay.index === 0 && replaySecond !== undefined ? { kind: 'second' } : { kind: 'done' }
        continue
      }
      if (replay.kind === 'second') {
        if (eventTs.slice(0, 19) === replaySecond) {
          return false
        }
        replay = { kind: 'done' }
        continue
      }
      return true
    }
  }
  // Branch/goal/resume forks copy the parent rollout's lines VERBATIM into the
  // new file, keeping the original timestamps — nothing is re-stamped, so the
  // same-second heuristic above can't catch them. But the file's own events can
  // only be stamped after its creation instant, which the filename's UUIDv7
  // embeds in UTC (the readable filename timestamp is LOCAL time — never use
  // it). Any event_msg/response_item older than that instant is copied history.
  // Covers what ccusage's cross-file dedupe catches, but per-file, so
  // incremental re-parses of the live branch file alone stay correct.
  const creationMs = rolloutCreationMs(filePath)
  // Running cumulative baseline. Some Codex builds emit token_count events that
  // carry only info.total_token_usage (a cumulative), with no per-turn
  // last_token_usage. For those we derive the turn's usage as current-minus-previous
  // cumulative — so we must track the last cumulative we saw. Mirrors ccusage's
  // previous_totals in subtract_codex_raw_usage. `undefined` means no cumulative
  // has been seen yet, which is distinct from an all-zero one: the first event of
  // a file must never look like a repeat of the baseline (ccusage's Option).
  let previousTotals: CodexCumulative | undefined
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
      // Deliberately NOT reading `model_provider` here — see
      // firstCodexTurnContextModel; `model` was seeded from it above.
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
      model = normalizeCodexModel(stringField(payload, 'model'), ts) || model
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
        const headlessTs = headlessCodexTimestamp(raw) || ts
        model = normalizeCodexModel(headlessCodexModel(raw), headlessTs) || model
        const eventModel = model || 'gpt-5'
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

    // Copied history from an earlier session (see creationMs above). Skip the
    // line entirely — counting it would double the parent's tokens, prompts,
    // tool calls, and active duration — but still advance the cumulative
    // baseline from copied token_counts so the first live event's delta is
    // measured against the copied prior cumulative, not zero.
    if (creationMs !== undefined && Date.parse(ts) < creationMs) {
      if (payloadType === 'token_count') {
        const step = codexTokenCountUsage(payload, previousTotals)
        previousTotals = step.nextTotals
        // Keep the parent-stream match aligned with what the anchor already
        // dropped. Both layers target the same copied history, so a copied event
        // the anchor removed must still consume its slot in the parent prefix —
        // otherwise the rollout's first real event gets compared against the
        // prefix head and can be mistaken for replay. Only advance on a match:
        // this line is discarded either way, so it must not push the state
        // machine off `matching` for the events that follow.
        if (step.usage && replay.kind === 'matching'
          && (replayPrefix ?? [])[replay.index] === codexUsageKey(step.usage)) {
          replay = { kind: 'matching', index: replay.index + 1 }
        }
      }
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
        const step = codexTokenCountUsage(payload, previousTotals)
        // Advance the baseline from every total_token_usage we see — including
        // replayed events we skip — so the first real event's delta is measured
        // against the right prior cumulative.
        previousTotals = step.nextTotals
        const usage = step.usage
        if (usage) {
          const usageKey = codexUsageKey(usage)
          // Drop the parent history a forked rollout replayed on open.
          if (!admitReplayedUsage(usageKey, ts)) {
            break
          }
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

// Codex stamps `codex-auto-review` as the model on its automatic code-review
// turns. It is a label, not a model — the tokens are billed against whichever
// review model Codex shipped on that date. Ported from ccusage's
// codex_log_model_fallback + codex-auto-review-fallbacks.json
// (rust/crates/ccusage/src/adapter/codex/parser.rs). Newest first; keep in
// sync when ccusage refreshes its snapshot. Note the table stops at gpt-5.5,
// so any review turn after 2026-04-23 resolves to it — upstream has not
// published a gpt-5.6-era row. That is not cost-neutral (gpt-5.6-sol carries
// an explicit cache-creation rate gpt-5.5 does not), just the best available
// evidence about which model actually ran.
const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review'
const CODEX_AUTO_REVIEW_FALLBACKS: ReadonlyArray<{ releasedOn: string, model: string }> = [
  { releasedOn: '2026-04-23', model: 'gpt-5.5' },
  { releasedOn: '2026-03-05', model: 'gpt-5.4' },
  { releasedOn: '2026-02-05', model: 'gpt-5.3-codex' },
  { releasedOn: '2025-12-11', model: 'gpt-5.2-codex' },
  { releasedOn: '2025-11-13', model: 'gpt-5.1-codex' },
  { releasedOn: '2025-09-15', model: 'gpt-5-codex' },
  { releasedOn: '2025-08-07', model: 'gpt-5' },
]

// Turn a raw Codex model string into a name the backend pricing catalogue can
// resolve:
//   - `gpt-5.5(xhigh)` / `gpt-5.4 (high)` — some third-party Codex proxies
//     append the reasoning effort. It is not part of any catalogue id and
//     pricing never varies by effort, so drop it.
//   - `codex-auto-review` — resolve to the review model shipping at `ts`.
function normalizeCodexModel(model: string | undefined, ts: string | undefined): string | undefined {
  if (!model) {
    return model
  }
  const cleaned = model.replace(/\s*\([^)]*\)\s*$/, '').trim() || model
  if (cleaned !== CODEX_AUTO_REVIEW_MODEL) {
    return cleaned
  }
  const date = ts?.slice(0, 10)
  const fallback = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? CODEX_AUTO_REVIEW_FALLBACKS.find(entry => date >= entry.releasedOn)
    : undefined
  // Pre-dating the whole table (or an unparseable ts) means the oldest
  // release is the best guess — same default ccusage uses.
  return fallback?.model ?? 'gpt-5'
}

// `session_meta` carries `model_provider` (an API provider id — `openai`, or
// whatever name a proxy gives itself), never a model; the model lives in
// `turn_context.model`. Scan ahead for the first one so events emitted before
// the first turn_context (session.started, plus any usage line that precedes
// it) still carry the real model. Reading `model_provider` into `model` is
// how `openai` / `crs` / `custom` used to reach the model leaderboard.
function firstCodexTurnContextModel(lines: string[]): string | undefined {
  for (const line of lines) {
    // Cheap reject first — re-parsing every line of a large rollout is not
    // worth it when turn_context normally sits within the first few lines.
    if (!line.includes('"turn_context"')) {
      continue
    }
    const raw = parseJsonLine(line)
    if (!raw || stringField(raw, 'type') !== 'turn_context') {
      continue
    }
    const model = normalizeCodexModel(
      stringField(objectField(raw, 'payload'), 'model'),
      timestampFrom(raw.timestamp),
    )
    if (model) {
      return model
    }
  }
  return undefined
}

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

// Codex rollout filenames are `rollout-<LOCAL time>-<UUIDv7>.jsonl`. The UUIDv7's
// first 48 bits are the creation instant in Unix ms (UTC) — verified against real
// rollouts across codex 0.4x–0.80, always within ~15ms of (and never after) the
// file's first own event. The readable timestamp is local time and MUST NOT be
// compared against event timestamps (which are UTC). Returns undefined for
// non-rollout names (headless logs, history.jsonl), disabling the anchor.
const ROLLOUT_UUID7_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

function rolloutCreationMs(filePath: string): number | undefined {
  const match = path.basename(filePath).match(ROLLOUT_UUID7_RE)
  if (!match) {
    return undefined
  }
  const ms = Number.parseInt(match[1] + match[2], 16)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

// ── forked-session replay: match the copied prefix against the parent stream ──

interface CodexStreamEvent {
  key: string
  tsMs: number | undefined
}

// The `session_meta` line names the session this rollout forked from: branch and
// resume forks set `forked_from_id`, subagent spawns nest the id under
// `source.subagent.thread_spawn.parent_thread_id`. The line's own timestamp is the
// fork instant. Mirrors ccusage read_codex_session_metadata (adapter/codex/replay.rs).
function codexForkInfo(lines: string[]): { parentId: string | undefined, forkedAtMs: number | undefined } {
  const raw = lines.length > 0 ? parseJsonLine(lines[0]) : undefined
  if (!raw || stringField(raw, 'type') !== 'session_meta') {
    return { parentId: undefined, forkedAtMs: undefined }
  }
  const payload = objectField(raw, 'payload')
  const threadSpawn = objectField(objectField(objectField(payload, 'source'), 'subagent'), 'thread_spawn')
  const parentId = stringField(payload, 'forked_from_id') || stringField(threadSpawn, 'parent_thread_id')
  const forkedAt = timestampFrom(raw.timestamp)
  return {
    parentId: parentId || undefined,
    forkedAtMs: forkedAt ? Date.parse(forkedAt) : undefined,
  }
}

// Rollout filenames embed the session id: `rollout-<local time>-<session uuid>.jsonl`,
// where the uuid equals `session_meta.payload.id` (verified against real rollouts).
// That lets a parent be located from its id without opening candidate files.
const ROLLOUT_SESSION_ID_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

function codexSessionIdFromFileName(filePath: string): string | undefined {
  return path.basename(filePath).match(ROLLOUT_SESSION_ID_RE)?.[1]
}

// Codex lays sessions out as `<CODEX_HOME>/sessions/YYYY/MM/DD/` and rotates old
// ones into `archived_sessions/`, so a parent can sit under either root and under
// any date. Outside that layout (relocated logs, tests) search the child's own
// directory. Active sessions come first so they win over an archived copy.
function codexRolloutSearchRoots(childPath: string): string[] {
  const dir = path.dirname(childPath)
  const parts = dir.split(path.sep)
  const index = Math.max(parts.lastIndexOf('sessions'), parts.lastIndexOf('archived_sessions'))
  if (index <= 0) {
    return [dir]
  }
  const codexRoot = parts.slice(0, index).join(path.sep)
  return [path.join(codexRoot, 'sessions'), path.join(codexRoot, 'archived_sessions')]
}

const codexSessionIndexCache = new Map<string, Promise<Map<string, string>>>()

async function buildCodexSessionIndex(roots: string[]): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  for (const root of roots) {
    let files: string[]
    try {
      files = await listJsonlFiles(root)
    }
    catch {
      continue
    }
    for (const file of files) {
      const id = codexSessionIdFromFileName(file)
      if (id && !index.has(id)) {
        index.set(id, file)
      }
    }
  }
  return index
}

async function codexRolloutPathForSession(childPath: string, sessionId: string): Promise<string | undefined> {
  const roots = codexRolloutSearchRoots(childPath)
  const cacheKey = roots.join('\0')
  let index = codexSessionIndexCache.get(cacheKey)
  if (!index) {
    index = buildCodexSessionIndex(roots)
    codexSessionIndexCache.set(cacheKey, index)
  }
  const sessionPaths = await index
  return sessionPaths.get(sessionId)
}

interface CodexUsageStreamCacheEntry { mtimeMs: number, size: number, stream: CodexStreamEvent[] }

const codexUsageStreamCache = new Map<string, CodexUsageStreamCacheEntry>()

/**
 * The usage a session recorded, in order, with NO replay filtering applied.
 *
 * A nested fork replays its parent's whole stream — including the history that
 * parent had itself copied from the grandparent — so the prefix only lines up
 * against the *unfiltered* stream. Mirrors ccusage read_usage_events, which visits
 * the parent with `replayed_prefix: None` (adapter/codex/replay.rs).
 *
 * Only session-format `token_count` lines are read: a rollout must carry a
 * session_meta to be named as someone's parent, so headless `codex exec` files
 * never appear here.
 */
async function codexUsageStream(filePath: string): Promise<CodexStreamEvent[]> {
  let info
  try {
    info = await stat(filePath)
  }
  catch {
    return []
  }
  const cached = codexUsageStreamCache.get(filePath)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.stream
  }

  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  }
  catch {
    return []
  }

  const stream: CodexStreamEvent[] = []
  let previousTotals: CodexCumulative | undefined
  for (const line of text.split('\n')) {
    if (!line) {
      continue
    }
    const raw = parseJsonLine(line)
    if (!raw || stringField(raw, 'type') !== 'event_msg') {
      continue
    }
    const payload = objectField(raw, 'payload')
    if (stringField(payload, 'type') !== 'token_count') {
      continue
    }
    const step = codexTokenCountUsage(payload, previousTotals)
    previousTotals = step.nextTotals
    if (!step.usage) {
      continue
    }
    const ts = timestampFrom(raw.timestamp) || timestampFrom(payload.timestamp)
    stream.push({ key: codexUsageKey(step.usage), tsMs: ts ? Date.parse(ts) : undefined })
  }

  codexUsageStreamCache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, stream })
  return stream
}

/**
 * Usage keys a forked rollout replayed from its parent, in order.
 *
 * Returns undefined for rollouts that are not forks, and an empty array for forks
 * whose parent log is unavailable — which tells the caller to fall back to the
 * rewritten-second heuristic. Mirrors CodexReplayPlan::replay_prefix.
 */
async function codexReplayPrefix(filePath: string, lines: string[]): Promise<string[] | undefined> {
  const { parentId, forkedAtMs } = codexForkInfo(lines)
  if (!parentId) {
    return undefined
  }
  // A session listing itself as its own parent would match its whole stream and
  // drop every event it recorded.
  if (codexSessionIdFromFileName(filePath) === parentId) {
    return []
  }
  const parentPath = await codexRolloutPathForSession(filePath, parentId)
  if (!parentPath || path.resolve(parentPath) === path.resolve(filePath)) {
    return []
  }
  const stream = await codexUsageStream(parentPath)
  // Usage the parent recorded after the fork was never replayed, so it must not
  // mask the child's own events.
  const after = forkedAtMs === undefined
    ? -1
    : stream.findIndex(event => event.tsMs !== undefined && event.tsMs > forkedAtMs)
  const replayed = after === -1 ? stream : stream.slice(0, after)
  return replayed.map(event => event.key)
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

type CodexUsageMetrics = NonNullable<ReturnType<typeof tokenUsageFromPayload>>

// Identity of a usage event: the token counts themselves. Used both to dedupe
// consecutive repeats and to line a forked rollout's replayed history up against
// its parent's stream, where Codex copies the counts but rewrites everything else.
function codexUsageKey(usage: CodexUsageMetrics): string {
  return [
    usage.tokensInput,
    usage.tokensCachedInput,
    usage.tokensOutput,
    usage.tokensReasoningOutput,
    usage.tokensTotal,
  ].join(':')
}

/**
 * Per-turn usage carried by one `token_count` payload, plus the cumulative
 * baseline to carry into the next one.
 *
 * Prefers `last_token_usage`; otherwise derives the delta from the cumulative
 * `total_token_usage` minus the running baseline, so token_count events that
 * carry only a cumulative total are counted instead of dropped.
 *
 * Codex re-emits a last_token_usage snapshot when only metadata around it changed
 * (rate limits, service tier). The cumulative is the authority: if
 * total_token_usage did not advance, no new tokens were spent, so the snapshot is
 * a repeat of one already counted. Mirrors ccusage's cumulative_advanced filter
 * (adapter/codex/parser.rs).
 */
function codexTokenCountUsage(
  payload: Record<string, unknown>,
  previousTotals: CodexCumulative | undefined,
): { usage: CodexUsageMetrics | undefined, nextTotals: CodexCumulative | undefined } {
  const info = objectField(payload, 'info')
  const totalUsage = objectField(info, 'total_token_usage')
  const hasTotal = Object.keys(totalUsage).length > 0
  const cumulativeAdvanced = !hasTotal
    || previousTotals === undefined
    || !sameCodexCumulative(previousTotals, readCodexCumulative(totalUsage))
  const usage = (cumulativeAdvanced ? tokenUsageFromPayload(payload) : undefined)
    ?? (hasTotal ? codexUsageDelta(totalUsage, previousTotals, info) : undefined)
  return {
    usage,
    nextTotals: hasTotal ? readCodexCumulative(totalUsage) : previousTotals,
  }
}

function sameCodexCumulative(a: CodexCumulative, b: CodexCumulative): boolean {
  return a.input === b.input
    && a.cached === b.cached
    && a.output === b.output
    && a.reasoning === b.reasoning
    && a.total === b.total
}

// Per-turn delta from a cumulative total_token_usage minus the prior cumulative
// baseline (ccusage subtract_codex_raw_usage). Returns undefined when the delta is
// entirely zero (e.g. a repeated cumulative) so no empty usage event is emitted.
function codexUsageDelta(
  totalUsage: Record<string, unknown>,
  previous: CodexCumulative | undefined,
  info: Record<string, unknown>,
) {
  const cur = readCodexCumulative(totalUsage)
  const input = Math.max(0, cur.input - (previous?.input ?? 0))
  const cached = Math.max(0, cur.cached - (previous?.cached ?? 0))
  const output = Math.max(0, cur.output - (previous?.output ?? 0))
  const reasoning = Math.max(0, cur.reasoning - (previous?.reasoning ?? 0))
  const total = Math.max(0, cur.total - (previous?.total ?? 0))
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
        // Codex moves old rollouts here as it rotates; include so pre-existing
        // archived history is discovered, not silently dropped. Actual file
        // listing dedups active vs archived — see codexBackfillFiles.
        path.join(base, 'archived_sessions'),
        path.join(base, 'history.jsonl'),
      ]
    },

    parseSessionFile: parseCodexSessionFile,
  }
}

// Discover Codex session files across the active sessions/ dir AND the
// archived_sessions/ dir Codex rotates old rollouts into, so rotated history is
// still captured. When the same rollout exists in both (same relative path — a
// leftover active copy), the active copy wins so its tokens are not counted
// twice. Mirrors ccusage collect_deduped_codex_usage_files. A --source-root
// override lists that root verbatim, with no active/archived merge.
export async function codexBackfillFiles(
  sourceRoot: string | undefined,
  home: string,
  env: AdapterEnv | undefined,
): Promise<{ path: string, modifiedAt: string }[]> {
  const files = sourceRoot ? await listJsonlFiles(sourceRoot) : await codexDefaultFiles(home, env)
  return Promise.all(files.map(async (filePath) => {
    const info = await stat(filePath)
    return { path: filePath, modifiedAt: info.mtime.toISOString() }
  }))
}

async function codexDefaultFiles(home: string, env: AdapterEnv | undefined): Promise<string[]> {
  const base = codexHome(home, env)
  const sessionsDir = path.join(base, 'sessions')
  const archivedDir = path.join(base, 'archived_sessions')

  const [activeFiles, archivedFiles, historyFiles] = await Promise.all([
    listJsonlFiles(sessionsDir),
    listJsonlFiles(archivedDir),
    listJsonlFiles(path.join(base, 'history.jsonl')),
  ])

  const activeRelative = new Set(activeFiles.map(f => path.relative(sessionsDir, f)))
  const dedupedArchived = archivedFiles.filter(f => !activeRelative.has(path.relative(archivedDir, f)))

  return [...activeFiles, ...dedupedArchived, ...historyFiles]
}
