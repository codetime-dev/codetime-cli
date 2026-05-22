import type {
  BackfillCandidate,
  BackfillPlan,
  BackfillSourceId,
  CanonicalEvent,
  SessionRollup,
} from '@codetime/shared'
import type { BackfillSourceDefinition } from './lib/backfill.js'
import type { BackfillImportCounts, BackfillIncrementalState, BackfillSourceFile, ParsedArgs, RunContext, SyncLocalLock, SyncLocalTriggerState, WritableLike } from './lib/types.js'
import { spawn } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENT_TIME_SCHEMA_VERSION,
  createImportKey,
  createPayloadHash,
  createStableHash,
} from '@codetime/shared'
import { cac } from 'cac'
import { ampBackfillFiles, createAmpAdapter } from './adapters/amp.js'
import { createClaudeCodeAdapter } from './adapters/claude-code.js'
import { createCodexAdapter } from './adapters/codex.js'
import { createHermesAdapter, hermesBackfillFiles } from './adapters/hermes.js'
import { createOpenCodeAdapter, opencodeBackfillFiles } from './adapters/opencode.js'
import { createPiAdapter } from './adapters/pi.js'
import { AdapterRegistry } from './adapters/registry.js'
import { buildSessionRollups } from './backfill/rollup.js'
import { installEntry } from './install/manager.js'
import { matchesBackfillFilters } from './lib/backfill.js'
import { defaultMachineName, ensureLocalMachineId, readConfig, writeConfig } from './lib/config.js'
import { DEFAULT_API_URL, DEFAULT_BACKFILL_BATCH_BYTES, DEFAULT_BACKFILL_BATCH_SIZE, DEFAULT_HOOK_SYNC_MIN_INTERVAL_SECONDS, PACKAGE_VERSION } from './lib/constants.js'
import { isPlainObject, numberOption, stringOption, valuesOption } from './lib/fields.js'
import { countDirectoryEntries, listJsonlFiles, pathExists, readJsonIfExists } from './lib/fs.js'
import { logError } from './lib/logger.js'
import { ProgressBar } from './lib/progress.js'
import {
  deleteMachine,
  deleteRollupsBySource,
  listMachines,
  postRollupBatch,
  renameMachine,
  resolveRemote,
} from './lib/remote.js'
import { BACKFILL_STATE_SCHEMA_VERSION } from './lib/types.js'

// ── Registry ──

function createRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(createCodexAdapter())
  registry.register(createClaudeCodeAdapter())
  registry.register(createPiAdapter())
  registry.register(createOpenCodeAdapter())
  registry.register(createAmpAdapter())
  registry.register(createHermesAdapter())
  return registry
}

// ── Run context ──

const defaultContext: RunContext = {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  fetch: globalThis.fetch,
  spawn,
}

export async function run(argv: string[], context: Partial<RunContext> = {}): Promise<number> {
  const ctx = { ...defaultContext, ...context }
  const cli = createCli(ctx, createRegistry())

  try {
    if (argv.length === 0) {
      write(ctx.stdout, helpText())
      return 0
    }

    cli.parse(['node', 'codetime', ...argv], { run: false })

    if (cli.options.help) {
      write(ctx.stdout, helpText())
      return 0
    }

    if (cli.options.version && !cli.matchedCommandName) {
      write(ctx.stdout, `${PACKAGE_VERSION}\n`)
      return 0
    }

    if (!cli.matchedCommand) {
      const command = cli.args[0]
      write(ctx.stderr, `Unknown command: ${command}\n\n${helpText()}`)
      return 1
    }

    return Number(await cli.runMatchedCommand()) || 0
  }
  catch (error) {
    write(ctx.stderr, `${(error as Error).message}\n`)
    await logError('cli', error, { argv })
    return 1
  }
}

// ── CLI Definition ──

function createCli(ctx: RunContext, registry: AdapterRegistry) {
  const cli = cac('codetime')

  cli
    .option('-h, --help', 'Show help')
    .option('-v, --version', 'Print CLI version')
    .option('--home <path>', 'Override the user home directory')
    .option('--api-url <url>', 'Agent Time API URL')
    .option('--token <token>', 'Bearer token for the Agent Time API')
    .option('--dry-run', 'Print the planned action without writing or reporting')
    .option('--json', 'Print JSON output')

  cli.command('help', 'Show help')
    .action(() => {
      write(ctx.stdout, helpText()); return 0
    })

  cli.command('version', 'Print CLI version')
    .action(() => {
      write(ctx.stdout, `${PACKAGE_VERSION}\n`); return 0
    })

  cli.command('detect', 'Show supported local targets and install status')
    .action(options => detectCommand(normalizeOptions(options), ctx, registry).then(() => 0))

  cli.command('install', 'Install integration files into detected or requested targets')
    .option('--target <targets>', 'Target integrations, comma-separated')
    .option('--targets <targets>', 'Target integrations, comma-separated')
    .option('--all', 'Install all supported integrations')
    .option('--force', 'Overwrite existing non-generated files when needed')
    .action(options => installCommand(normalizeOptions(options), ctx, registry))

  cli.command('hook', 'Read agent hook JSON from stdin and report a throttled event')
    .option('--agent <name>', 'Agent name')
    .option('--project <name>', 'Project name')
    .option('--min-interval <seconds>', 'Minimum seconds between similar hook reports')
    .action(options => hookCommand(normalizeOptions(options), ctx))

  cli.command('sync-local-trigger', 'Trigger one background local sync with throttle and locking')
    .option('--min-interval <seconds>', 'Minimum seconds between sync triggers')
    .action(options => syncLocalTriggerCommand(normalizeOptions(options), ctx, registry))

  cli.command('sync-local-runner', 'Internal background local sync runner')
    .option('--lock-file <path>', 'Lock file for the active sync')
    .option('--state-file <path>', 'State file for trigger metadata')
    .action(options => syncLocalRunnerCommand(normalizeOptions(options), ctx, registry))

  cli.command('backfill [action]', 'Inspect local history import candidates')
    .option('--source <source>', 'Backfill source')
    .option('--since <time>', 'Only include history after this time')
    .option('--until <time>', 'Only include history before this time')
    .option('--project <name>', 'Project filter')
    .option('--source-root <path>', 'Override source history root')
    .option('--include-source-path', 'Include local source paths in output')
    .option('--import-run <id>', 'Import run id for verify/resume workflows')
    .option('--limit <count>', 'Maximum session files to parse')
    .option('--batch-size <count>', 'Max rollups per request (also bounded by --batch-bytes)')
    .option('--batch-bytes <bytes>', 'Soft byte cap for the JSON body of a single ingest POST')
    .option('--replace', 'Replace conflicting records during import (default)')
    .option('--skip-conflicts', 'Skip conflicting records instead of replacing them')
    .option('--force', 'Force full re-import: clear watermark and re-process all files')
    .action((action, options) => backfillCommand({ ...normalizeOptions(options), action }, ctx, registry))

  // `token` is the only path to set credentials — the agent CLI reuses
  // the user's existing upload_token (visible in the codetime
  // dashboard's Settings page), so there is no device-flow login.
  //   token set <value>   write to ~/.codetime/config.json
  //   token show          print masked token + remoteUrl
  //   token clear         remove only the token (keep remoteUrl)
  cli.command('token [action] [value]', 'Set, show, or clear the persisted API token')
    .option('--remote <url>', 'Override API base URL when setting a token')
    .action((action, value, options) => tokenCommand(action, value, normalizeOptions(options), ctx))

  cli.command('machine [action]', 'List or rename machines (requires login)')
    .option('--name <name>', 'New display name (used by `machine rename`)')
    .option('--id <id>', 'Machine id (defaults to current machine)')
    .action((action, options) => machineCommand(action, normalizeOptions(options), ctx))

  return cli
}

function normalizeOptions(options: Record<string, unknown>): ParsedArgs {
  const normalized: ParsedArgs = { ...options, _: [] }
  const aliases: Record<string, string> = {
    apiUrl: 'api-url',
    dryRun: 'dry-run',
    linesAdded: 'lines-added',
    linesRemoved: 'lines-removed',
    minInterval: 'min-interval',
    lockFile: 'lock-file',
    stateFile: 'state-file',
    sourceRoot: 'source-root',
    importRun: 'import-run',
    batchSize: 'batch-size',
    batchBytes: 'batch-bytes',
    skipConflicts: 'skip-conflicts',
  }

  for (const [camel, dashed] of Object.entries(aliases)) {
    if (normalized[camel] !== undefined && normalized[dashed] === undefined) {
      normalized[dashed] = normalized[camel]
    }
  }

  return normalized
}

// ── Commands ──

async function detectCommand(options: ParsedArgs, ctx: RunContext, registry: AdapterRegistry) {
  const home = resolveHome(options, ctx)
  const env = ctx.env
  const adapters = registry.all()
  const targets = await Promise.all(adapters.map(async (adapter) => {
    const detected = await pathExists(adapter.detectPath(home, env))
    const installed = await adapter.isInstalled(home, env)
    return {
      id: adapter.id,
      label: adapter.label,
      kind: adapter.kind,
      detected,
      installed,
      detectPath: adapter.detectPath(home, env),
      installedPath: adapter.installedPath(home, env),
    }
  }))

  if (options.json) {
    write(ctx.stdout, `${JSON.stringify({ home, targets }, null, 2)}\n`)
    return
  }

  for (const target of targets) {
    const detected = target.detected ? 'detected' : 'missing'
    const installed = target.installed ? 'installed' : 'not installed'
    write(ctx.stdout, `${target.id.padEnd(8)} ${detected.padEnd(8)} ${installed.padEnd(13)} ${target.detectPath}\n`)
  }
}

async function installCommand(options: ParsedArgs, ctx: RunContext, registry: AdapterRegistry): Promise<number> {
  const home = resolveHome(options, ctx)
  const env = ctx.env
  const dryRun = Boolean(options['dry-run'])
  const force = Boolean(options.force)
  const allAdapters = registry.all()
  const requested = requestedTargets(options)
  const unknown = requested.filter(id => !allAdapters.some(a => a.id === id))

  if (unknown.length > 0) {
    throw new Error(`Unknown target(s): ${unknown.join(', ')}`)
  }

  const detected: string[] = []
  for (const adapter of allAdapters) {
    if (await pathExists(adapter.detectPath(home, env))) {
      detected.push(adapter.id)
    }
  }

  const selectedIds = requested.length > 0
    ? requested
    : options.all
      ? allAdapters.map(a => a.id)
      : detected

  if (selectedIds.length === 0) {
    write(ctx.stderr, 'No supported local targets were detected. Use --target codex,claude,opencode,pi,amp or --all to create them.\n')
    return 1
  }

  for (const adapter of allAdapters.filter(a => selectedIds.includes(a.id))) {
    for (const entry of adapter.installEntries(home, env)) {
      await installEntry(entry, {
        dryRun,
        force,
        onWrite: msg => write(ctx.stdout, `${msg}\n`),
      })
    }
  }

  return 0
}

// The hook command is a thin trigger: it drains stdin so the upstream agent
// doesn't block on a closed pipe, then schedules a local backfill run.
// Backfill's mtime watermark and per-adapter parsers do all the real work
// (model.usage assembly, token dedup, service_tier rewrites, etc.) — keeping
// the hook side reactive but stateless avoids two copies of every parser.
async function hookCommand(options: ParsedArgs, ctx: RunContext): Promise<number> {
  const home = resolveHome(options, ctx)
  try {
    const agent = requiredOption(options, 'agent')
    const payload = await readHookPayload(ctx.stdin)

    if (options['dry-run']) {
      // Echo the raw payload so users debugging hook wiring can see exactly
      // what the agent forwarded. No event assembly, no cost estimate —
      // those happen on the backfill side.
      write(ctx.stdout, `${JSON.stringify({
        agent,
        received: payload,
        wouldTrigger: 'backfill',
      }, null, 2)}\n`)
      return 0
    }

    return await syncLocalTriggerCommand({
      ...options,
      agent,
      'min-interval': stringOption(options['min-interval']) || String(DEFAULT_HOOK_SYNC_MIN_INTERVAL_SECONDS),
    }, ctx)
  }
  catch (error) {
    // Hooks run inside the user's agent (Claude Code, Codex, etc).
    // Bubbling an error there spams the user with stderr; persist to the
    // log file and exit 0 so the agent isn't disturbed.
    await logError('hook', error, { agent: stringOption(options.agent) }, home)
    debug(ctx, `[codetime] hook failed: ${(error as Error).message}\n`)
    return 0
  }
}

async function syncLocalTriggerCommand(options: ParsedArgs, ctx: RunContext, _registry?: AdapterRegistry): Promise<number> {
  const home = resolveHome(options, ctx)
  const statePath = syncLocalTriggerStatePath(home)
  const lockPath = syncLocalTriggerLockPath(home)
  const minIntervalSeconds = Math.max(0, Math.floor(numberOption(options['min-interval']) ?? DEFAULT_HOOK_SYNC_MIN_INTERVAL_SECONDS))
  const now = new Date().toISOString()
  const lock = await readSyncLocalLock(lockPath)
  if (lock && await isProcessRunning(lock.pid)) {
    if (options.json || options['dry-run']) {
      write(ctx.stdout, `${JSON.stringify({ status: 'already-running', pid: lock.pid, startedAt: lock.startedAt }, null, 2)}\n`)
    }
    return 0
  }
  if (lock) {
    await clearSyncLocalLock(lockPath)
  }

  const state = await readSyncLocalTriggerState(statePath)
  if (minIntervalSeconds > 0 && state.lastTriggeredAt) {
    const elapsedMs = Date.parse(now) - Date.parse(state.lastTriggeredAt)
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < minIntervalSeconds * 1000) {
      if (options.json || options['dry-run']) {
        write(ctx.stdout, `${JSON.stringify({ status: 'throttled', lastTriggeredAt: state.lastTriggeredAt, minIntervalSeconds }, null, 2)}\n`)
      }
      return 0
    }
  }

  if (options['dry-run']) {
    write(ctx.stdout, `${JSON.stringify({ status: 'would-trigger', minIntervalSeconds }, null, 2)}\n`)
    return 0
  }

  const child = spawnSyncLocalRunner({ options, ctx, home, lockPath, statePath, triggeredAt: now })
  if (typeof child.pid !== 'number') {
    throw new TypeError('Could not start background sync-local runner')
  }

  state.lastTriggeredAt = now
  state.pid = child.pid
  await writeSyncLocalTriggerState(statePath, state)
  await writeSyncLocalLock(lockPath, { pid: child.pid, startedAt: now })
  return 0
}

async function syncLocalRunnerCommand(options: ParsedArgs, ctx: RunContext, _registry?: AdapterRegistry): Promise<number> {
  const home = resolveHome(options, ctx)
  const lockPath = stringOption(options['lock-file']) || syncLocalTriggerLockPath(home)
  const statePath = stringOption(options['state-file']) || syncLocalTriggerStatePath(home)
  const state = await readSyncLocalTriggerState(statePath)
  state.lastStartedAt = new Date().toISOString()
  state.pid = process.pid
  await writeSyncLocalTriggerState(statePath, state)

  let exitCode = 1
  try {
    exitCode = await backfillCommand({
      ...options,
      action: 'import',
      source: 'all',
    }, ctx)
    return exitCode
  }
  catch (error) {
    // The runner is spawned detached with stdio: 'ignore', so the stack
    // trace would be lost otherwise. Persist it so users can diagnose.
    await logError('sync-local-runner', error, { home }, home)
    throw error
  }
  finally {
    const nextState = await readSyncLocalTriggerState(statePath)
    nextState.lastStartedAt = state.lastStartedAt
    nextState.lastCompletedAt = new Date().toISOString()
    nextState.lastExitCode = exitCode
    delete nextState.pid
    await writeSyncLocalTriggerState(statePath, nextState)
    await clearSyncLocalLock(lockPath)
  }
}

// ── Backfill ──

async function backfillCommand(options: ParsedArgs, ctx: RunContext, registry?: AdapterRegistry): Promise<number> {
  const reg = registry || createRegistry()
  const action = stringOption(options.action) || 'plan'
  if (!['discover', 'plan', 'import', 'verify'].includes(action)) {
    throw new Error(`Unknown backfill action: ${action}`)
  }

  if (action === 'verify') {
    return backfillVerifyCommand(options, ctx)
  }

  if (action === 'import' && !options['dry-run']) {
    const requested = normalizeBackfillSource(stringOption(options.source) || 'all')
    const supported = new Set<string>(['all', 'codex', 'claude-code', 'opencode', 'pi', 'amp'])
    if (!supported.has(requested)) {
      write(ctx.stderr, `Unsupported backfill source: ${requested}\n`)
      return 1
    }
    const plan = await createBackfillPlanFromOptions(options, ctx, 'discover', reg)
    return importBackfillPlan(plan, options, ctx, reg)
  }

  const plan = await createBackfillPlanFromOptions(options, ctx, action, reg)

  if (action === 'discover') {
    writeBackfillDiscover(plan, options, ctx)
    return 0
  }

  if (action === 'plan' || options['dry-run']) {
    writeBackfillPlan(plan, options, ctx)
    return 0
  }

  return importBackfillPlan(plan, options, ctx, reg)
}

async function createBackfillPlanFromOptions(
  options: ParsedArgs,
  ctx: RunContext,
  action: string,
  registry: AdapterRegistry,
): Promise<BackfillPlan> {
  const home = resolveHome(options, ctx)
  const env = ctx.env
  const source = normalizeBackfillSource(stringOption(options.source) || 'all')
  const sourceDefs = source === 'all'
    ? registry.all().map(a => ({ id: a.id, label: a.label, paths: a.sourcePaths(home, env) }))
    : (() => {
        const adapter = registry.get(source)
        if (!adapter) {
          return []
        }
        return [{ id: adapter.id, label: adapter.label, paths: adapter.sourcePaths(home, env) }]
      })()

  if (sourceDefs.length === 0) {
    throw new Error(`Unknown backfill source: ${source}`)
  }

  const candidateList = await Promise.all(sourceDefs.map(item => createBackfillCandidates(item, options)))
  const candidates = candidateList.flat()
  let events: CanonicalEvent[] = []
  if (action !== 'discover') {
    const eventList = await createBackfillEventsFromDefs(sourceDefs, options, registry, ctx)
    events = eventList.flat()
  }
  const plannedEvents = events.map(event => ({
    source: event.source as BackfillSourceId,
    importKey: event.refs?.importKey || event.id || '',
    eventId: event.id || '',
    payloadHash: createPayloadHash(event),
    type: event.type,
    confidence: event.confidence || 'estimated',
  }))
  const now = new Date().toISOString()
  const importRunId = `import_${createStableHash(createImportKey([
    source,
    action,
    now,
    stringOption(options.since),
    stringOption(options.until),
    stringOption(options.project),
    stringOption(options['source-root']),
  ])).slice(0, 24)}`

  return {
    importRun: {
      importRunId,
      source: source === 'all' ? 'all' : source as BackfillSourceId,
      status: 'planned',
      startedAt: now,
      parserVersion: PACKAGE_VERSION,
      schemaVersion: AGENT_TIME_SCHEMA_VERSION,
      dryRun: Boolean(options['dry-run']) || action !== 'import',
      filters: {
        since: stringOption(options.since),
        until: stringOption(options.until),
        project: stringOption(options.project),
        sourceRoot: stringOption(options['source-root']),
      },
      counts: {
        discovered: candidates.reduce((total, c) => total + (c.exists ? c.entries : 0), 0),
        planned: plannedEvents.length,
        inserted: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
      },
    },
    candidates,
    plannedEvents,
    privacy: 'metadata only; prompt text, command text, source code, and diffs are not imported',
  }
}

async function createBackfillEventsFromDefs(
  sourceDefs: BackfillSourceDefinition[],
  options: ParsedArgs,
  registry: AdapterRegistry,
  ctx: RunContext,
  overrideFiles?: string[],
): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = []
  const home = resolveHome(options, ctx)

  // Same isolation policy as the import path: one source blowing up
  // (e.g. older opencode SQLite schemas) must not poison the whole plan.
  for (const item of sourceDefs) {
    const parser = registry.getParser(item.id)
    if (!parser) {
      continue
    }

    let files: string[]
    try {
      const sourceFiles = await listBackfillSourceFiles(item, options, ctx)
      files = overrideFiles ?? sourceFiles.map(f => f.path)
    }
    catch (error) {
      await logError('backfill.listFiles', error, { source: item.id, phase: 'plan' }, home)
      debug(ctx, `[codetime] skip ${item.id} in plan: list files failed: ${(error as Error).message}\n`)
      continue
    }

    for (const filePath of files) {
      try {
        const parsed = await parser(filePath, options)
        for (const event of parsed) {
          if (matchesBackfillFilters(event, options)) {
            events.push(event)
          }
        }
      }
      catch (error) {
        await logError('backfill.parse', error, { source: item.id, file: filePath, phase: 'plan' }, home)
        debug(ctx, `[codetime] skip ${item.id} file ${filePath} in plan: ${(error as Error).message}\n`)
      }
    }
  }

  return events
}

async function createBackfillCandidates(
  source: BackfillSourceDefinition,
  options: ParsedArgs,
): Promise<BackfillCandidate[]> {
  const sourceRoot = stringOption(options['source-root'])
  const paths = sourceRoot ? [sourceRoot] : source.paths

  return Promise.all(paths.map(async (candidatePath) => {
    const exists = await pathExists(candidatePath)
    return {
      source: source.id,
      label: source.label,
      exists,
      entries: exists ? await countDirectoryEntries(candidatePath) : 0,
      pathHash: `sha256:${createStableHash(candidatePath)}`,
      path: options.includeSourcePath ? candidatePath : undefined,
    }
  }))
}

async function listBackfillSourceFiles(
  source: BackfillSourceDefinition,
  options: ParsedArgs,
  ctx: RunContext,
): Promise<BackfillSourceFile[]> {
  if (source.id === 'opencode') {
    return opencodeBackfillFiles(stringOption(options['source-root']), resolveHome(options, ctx), ctx.env)
  }
  if (source.id === 'amp') {
    return ampBackfillFiles(stringOption(options['source-root']), resolveHome(options, ctx), ctx.env)
  }
  if (source.id === 'hermes') {
    return hermesBackfillFiles(stringOption(options['source-root']), resolveHome(options, ctx), ctx.env)
  }

  const roots = stringOption(options['source-root'])
    ? [requiredOption(options, 'source-root')]
    : source.paths
  const fileLists = await Promise.all(roots.map(r => listJsonlFiles(r)))
  const files = fileLists
    .flat()
    .sort()
    .slice(0, numberOption(options.limit) || undefined)

  return Promise.all(files.map(async (filePath) => {
    const info = await stat(filePath)
    return { path: filePath, modifiedAt: info.mtime.toISOString() }
  }))
}

function writeBackfillDiscover(plan: BackfillPlan, options: ParsedArgs, ctx: RunContext) {
  if (options.json) {
    write(ctx.stdout, `${JSON.stringify({ importRun: plan.importRun, candidates: plan.candidates }, null, 2)}\n`)
    return
  }

  for (const candidate of plan.candidates) {
    const state = candidate.exists ? `found ${candidate.entries} entries` : 'missing'
    write(ctx.stdout, `${candidate.source.padEnd(12)} ${state.padEnd(16)} ${candidate.path || candidate.pathHash}\n`)
  }
}

function formatCountMap(map: Map<string, number>, limit = 6): string {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const visible = entries.slice(0, limit).map(([key, count]) => `${key}:${count}`)
  const rest = entries.slice(limit).reduce((total, [, count]) => total + count, 0)
  return rest > 0 ? `${visible.join(', ')} (+${rest} more)` : visible.join(', ')
}

function writeBackfillPlan(plan: BackfillPlan, options: ParsedArgs, ctx: RunContext) {
  if (options.json) {
    write(ctx.stdout, `${JSON.stringify(plan, null, 2)}\n`)
    return
  }

  write(ctx.stdout, `importRun ${plan.importRun.importRunId}\n`)
  write(ctx.stdout, `source ${plan.importRun.source}\n`)
  write(ctx.stdout, `discovered ${plan.importRun.counts.discovered}\n`)
  write(ctx.stdout, `planned ${plan.importRun.counts.planned}\n`)
  write(ctx.stdout, `${plan.privacy}\n`)

  const candidatesBySource = new Map<string, number>()
  for (const candidate of plan.candidates) {
    candidatesBySource.set(candidate.source, (candidatesBySource.get(candidate.source) || 0) + (candidate.exists ? candidate.entries : 0))
  }
  if (candidatesBySource.size > 0) {
    write(ctx.stdout, `candidates ${formatCountMap(candidatesBySource)}\n`)
  }

  const eventsBySource = new Map<string, number>()
  const eventsByType = new Map<string, number>()
  for (const event of plan.plannedEvents) {
    eventsBySource.set(event.source, (eventsBySource.get(event.source) || 0) + 1)
    eventsByType.set(event.type, (eventsByType.get(event.type) || 0) + 1)
  }
  if (eventsBySource.size > 0) {
    write(ctx.stdout, `events ${formatCountMap(eventsBySource)}\n`)
  }
  if (eventsByType.size > 0) {
    write(ctx.stdout, `types ${formatCountMap(eventsByType, 8)}\n`)
  }

  const samples = plan.plannedEvents.slice(0, 5)
  if (samples.length > 0) {
    write(ctx.stdout, 'sample\n')
    for (const event of samples) {
      write(ctx.stdout, `  ${event.eventId} ${event.source} ${event.type} ${event.confidence}\n`)
    }
    const remaining = plan.plannedEvents.length - samples.length
    if (remaining > 0) {
      write(ctx.stdout, `  ... ${remaining} more planned events (use --json for full details)\n`)
    }
  }
}

async function importBackfillPlan(
  plan: BackfillPlan,
  options: ParsedArgs,
  ctx: RunContext,
  registry: AdapterRegistry,
): Promise<number> {
  const source = normalizeBackfillSource(stringOption(options.source) || 'all')
  const supportedSources = new Set<BackfillSourceId>(['codex', 'claude-code', 'opencode', 'pi', 'amp'])
  const home = resolveHome(options, ctx)
  if (source !== 'all' && !supportedSources.has(source as BackfillSourceId)) {
    write(ctx.stderr, `Unsupported backfill source: ${source}\n`)
    return 1
  }

  const sourceDefs = registry.all()
    .filter(a => supportedSources.has(a.id) && (source === 'all' || a.id === source))
    .map(a => ({ id: a.id, label: a.label, paths: a.sourcePaths(home, ctx.env) }))

  if (options.force) {
    await purgeForcedSources(sourceDefs, home, options, ctx)
  }

  const incrementalState = shouldUseIncrementalBackfill(options)
    ? await readBackfillIncrementalState(home, ctx)
    : undefined

  if (!options.json) {
    write(ctx.stdout, `importRun ${plan.importRun.importRunId}\n`)
    write(ctx.stdout, `sources ${sourceDefs.map(s => s.id).join(', ') || 'none'}\n`)
  }

  const { canonicalEvents, selectedFilesBySource } = await collectCanonicalEvents(
    sourceDefs,
    registry,
    incrementalState,
    options,
    ctx,
  )

  const rollups = buildSessionRollups(canonicalEvents)
  const counts = await uploadSessionRollups(rollups, canonicalEvents.length, options, ctx)

  const result = {
    importRunId: plan.importRun.importRunId,
    source,
    planned: rollups.length,
    sourceEvents: canonicalEvents.length,
    ...counts,
  }

  if (options.json) {
    write(ctx.stdout, `${JSON.stringify(result, null, 2)}\n`)
  }

  if (counts.failed === 0 && counts.conflicts === 0 && incrementalState) {
    await updateBackfillIncrementalState(home, incrementalState, selectedFilesBySource)
  }

  return counts.failed > 0 || (counts.conflicts > 0 && !options['skip-conflicts']) ? 1 : 0
}

// Clear the local watermark and ask the server to drop existing
// rollups for each target source. Errors are non-fatal — we surface
// them via debug and let the import proceed, since the user
// explicitly asked for --force.
async function purgeForcedSources(
  sourceDefs: Array<{ id: BackfillSourceId, label: string, paths: string[] }>,
  home: string,
  options: ParsedArgs,
  ctx: RunContext,
): Promise<void> {
  try {
    // rm({force: true}) already swallows ENOENT, so anything reaching
    // here is a real I/O / permission problem.
    await rm(backfillIncrementalStatePath(home), { force: true })
  }
  catch (error) {
    debug(ctx, `Failed to clear backfill watermark: ${(error as Error).message}\n`)
  }

  for (const item of sourceDefs) {
    try {
      const deleted = await deleteSessionRollupsBySourceAPI(item.id, options, ctx)
      if (!options.json) {
        write(ctx.stdout, `purged ${item.id}: ${deleted} old rollups\n`)
      }
    }
    catch (error) {
      debug(ctx, `Failed to purge ${item.id} rollups: ${(error as Error).message}\n`)
    }
  }
}

// Walk each enabled source, run its parser over every file past the
// recorded watermark, and return the filtered canonical events. Also
// returns the per-source file lists so callers can advance watermarks
// once the upload succeeds.
async function collectCanonicalEvents(
  sourceDefs: Array<{ id: BackfillSourceId, label: string, paths: string[] }>,
  registry: AdapterRegistry,
  incrementalState: BackfillIncrementalState | undefined,
  options: ParsedArgs,
  ctx: RunContext,
): Promise<{
  canonicalEvents: CanonicalEvent[]
  selectedFilesBySource: Map<BackfillSourceId, BackfillSourceFile[]>
}> {
  const selectedFilesBySource = new Map<BackfillSourceId, BackfillSourceFile[]>()
  const canonicalEvents: CanonicalEvent[] = []
  const home = resolveHome(options, ctx)

  for (const item of sourceDefs) {
    const parser = registry.getParser(item.id)
    if (!parser) {
      continue
    }
    // Per-source isolation: a broken parser or missing history dir for
    // one source (e.g. opencode's older schemas) must not abort the
    // whole run. Failures land in ~/.codetime/logs/cli.log; the
    // watermark stays unadvanced because selectedFilesBySource only
    // gets populated on success.
    let selectedFiles: BackfillSourceFile[]
    try {
      const sourceFiles = await listBackfillSourceFiles(item, options, ctx)
      selectedFiles = selectBackfillFilesForImport(sourceFiles, incrementalState?.sources[item.id]?.watermarkTs)
    }
    catch (error) {
      await logError('backfill.listFiles', error, { source: item.id }, home)
      debug(ctx, `[codetime] skip ${item.id}: list files failed: ${(error as Error).message}\n`)
      continue
    }
    selectedFilesBySource.set(item.id, selectedFiles)
    const filePaths = selectedFiles.map(f => f.path)
    const sourceEvents: CanonicalEvent[] = []
    let sourceFailed = false

    const bar = options.json ? undefined : new ProgressBar(ctx.stdout, `${item.id.padEnd(12)}`)
    bar?.init(filePaths.length, `0 events`)
    for (let fi = 0; fi < filePaths.length; fi += 1) {
      try {
        const parsed = await parser(filePaths[fi], options)
        for (const event of parsed) {
          if (matchesBackfillFilters(event, options)) {
            sourceEvents.push(event)
          }
        }
      }
      catch (error) {
        sourceFailed = true
        await logError('backfill.parse', error, { source: item.id, file: filePaths[fi] }, home)
        debug(ctx, `[codetime] skip ${item.id} file ${filePaths[fi]}: ${(error as Error).message}\n`)
      }
      bar?.tick(`${fi + 1}/${filePaths.length} files, ${sourceEvents.length} events`)
    }
    bar?.finalize(`${sourceEvents.length} events${sourceFailed ? ' (partial — see logs)' : ''}`)

    // If any file failed to parse, drop this source from the watermark
    // update set so we retry on the next run instead of marking it as
    // fully imported.
    if (sourceFailed) {
      selectedFilesBySource.delete(item.id)
    }

    for (const event of sourceEvents) canonicalEvents.push(event)
  }

  return { canonicalEvents, selectedFilesBySource }
}

// Pre-pack rollups into batches bounded by BOTH count and serialized
// JSON byte size. The byte cap keeps us under nginx's default 1 MiB
// `client_max_body_size`; the count cap protects request latency on
// tiny rollups. A single rollup that exceeds the byte cap is sent on
// its own — the server may 413, surfaced as a batch failure.
async function uploadSessionRollups(
  rollups: SessionRollup[],
  eventCount: number,
  options: ParsedArgs,
  ctx: RunContext,
): Promise<BackfillImportCounts> {
  const counts: BackfillImportCounts = { inserted: 0, skipped: 0, conflicts: 0, failed: 0 }
  const batchSize = Math.max(1, Math.floor(numberOption(options['batch-size']) || DEFAULT_BACKFILL_BATCH_SIZE))
  const batchBytes = Math.max(64 * 1024, Math.floor(numberOption(options['batch-bytes']) || DEFAULT_BACKFILL_BATCH_BYTES))
  const batches = packRollupBatches(rollups, batchSize, batchBytes)
  const totalBatches = batches.length

  let uploadBar: ProgressBar | undefined
  if (!options.json) {
    write(ctx.stdout, `rollup ${rollups.length} from ${eventCount} events\n`)
    uploadBar = new ProgressBar(ctx.stdout, `upload`.padEnd(12))
    uploadBar.init(totalBatches, `0/${totalBatches} batches, 0 inserted`)
  }

  for (const [i, batch_] of batches.entries()) {
    const batch = batch_!
    const batchNumber = i + 1
    try {
      const result = await sendSessionRollupBatch(batch, options, ctx)
      counts.inserted += result.inserted
      counts.skipped += result.skipped
      counts.conflicts += result.conflicts
      counts.failed += result.failed
    }
    catch (error) {
      debug(ctx, `backfill rollup batch ${batchNumber}/${totalBatches} (${batch.length} rollups) failed: ${(error as Error).message}\n`)
      counts.failed += batch.length
    }
    uploadBar?.update(batchNumber, `${batchNumber}/${totalBatches} batches, inserted ${counts.inserted}`)
  }

  uploadBar?.finalize(`inserted ${counts.inserted} · skipped ${counts.skipped}${
    counts.conflicts ? ` · conflicts ${counts.conflicts}` : ''
  }${counts.failed ? ` · failed ${counts.failed}` : ''}`)

  return counts
}

function backfillVerifyCommand(options: ParsedArgs, ctx: RunContext): number {
  const importRunId = stringOption(options['import-run'])
  if (!importRunId) {
    write(ctx.stderr, 'Backfill verify requires --import-run <id>.\n')
    return 1
  }

  const result = {
    importRunId,
    status: 'not-implemented',
    message: 'Backfill verify will compare planned, inserted, skipped, and conflicted event counts once import runs are persisted.',
  }

  if (options.json) {
    write(ctx.stdout, `${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  write(ctx.stdout, `${result.importRunId} ${result.status}\n${result.message}\n`)
  return 0
}

// ── API Communication ──

async function sendSessionRollupBatch(
  rollups: SessionRollup[],
  options: ParsedArgs,
  ctx: RunContext,
): Promise<BackfillImportCounts> {
  const remote = resolveRemoteFromOptions(options, ctx)
  if (!remote) {
    throw new Error('No fetch available for HTTP upload')
  }
  // Identify this host for the server-side `machines` upsert. The id is
  // a UUID we mint once per machine in ~/.codetime/machine-id;
  // hostname/displayName/platform are sent as hints so the dashboard
  // shows something meaningful on first sight.
  const home = resolveHome(options, ctx)
  const cfg = readConfig(home)
  const machine = {
    id: ensureLocalMachineId(home),
    hostname: defaultMachineName(),
    displayName: cfg.machineName || defaultMachineName(),
    platform: process.platform,
  }
  const result = await postRollupBatch(remote, rollups, {
    replace: options['skip-conflicts'] !== true,
    machine,
  })
  return result
}

async function deleteSessionRollupsBySourceAPI(
  source: string,
  options: ParsedArgs,
  ctx: RunContext,
): Promise<number> {
  const remote = resolveRemoteFromOptions(options, ctx)
  if (!remote) {
    throw new Error('No fetch available for HTTP delete')
  }
  // The server scopes the purge to (userId, machineId) so passing the
  // local machine id is required, not optional.
  const home = resolveHome(options, ctx)
  return deleteRollupsBySource(remote, source, {
    id: ensureLocalMachineId(home),
    hostname: defaultMachineName(),
    platform: process.platform,
  })
}

// ── State management ──

function shouldUseIncrementalBackfill(options: ParsedArgs): boolean {
  return !stringOption(options.since)
    && !stringOption(options.until)
    && !stringOption(options['source-root'])
    && numberOption(options.limit) === undefined
}

// Strict watermark: only re-process files whose mtime advances past the
// recorded watermark. An active session that gets a new event will have
// its mtime advance naturally on the next run, so no grace window is
// needed — and a grace window would cause already-uploaded files to be
// resubmitted on every run.
// Group rollups into upload batches bounded by count AND serialized
// JSON byte size. The byte estimate uses the same serializer the HTTP
// layer will use (JSON.stringify), so it tracks the real wire size.
// Two-byte commas / brackets are ignored in the estimate — the actual
// body is `{"rollups":[...]}` and adds a fixed envelope, both well
// under any practical cap.
function packRollupBatches(
  rollups: SessionRollup[],
  maxCount: number,
  maxBytes: number,
): SessionRollup[][] {
  const batches: SessionRollup[][] = []
  let current: SessionRollup[] = []
  let currentBytes = 0
  for (const rollup of rollups) {
    const size = JSON.stringify(rollup).length
    const wouldExceed = current.length > 0
      && (current.length >= maxCount || currentBytes + size > maxBytes)
    if (wouldExceed) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(rollup)
    currentBytes += size
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}

function selectBackfillFilesForImport(
  files: BackfillSourceFile[],
  watermarkTs: string | undefined,
): BackfillSourceFile[] {
  if (!watermarkTs) {
    return files
  }
  const watermarkMs = Date.parse(watermarkTs)
  if (Number.isNaN(watermarkMs)) {
    return files
  }
  return files.filter((f) => {
    const modifiedMs = Date.parse(f.modifiedAt)
    return !Number.isNaN(modifiedMs) && modifiedMs > watermarkMs
  })
}

function backfillIncrementalStatePath(home: string): string {
  return path.join(home, '.codetime', 'backfill-state.json')
}

function syncLocalTriggerStatePath(home: string): string {
  return path.join(home, '.codetime', 'sync-local-trigger.json')
}

function syncLocalTriggerLockPath(home: string): string {
  return path.join(home, '.codetime', 'sync-local-trigger.lock')
}

async function readBackfillIncrementalState(home: string, ctx?: RunContext): Promise<BackfillIncrementalState> {
  // Corrupt JSON now surfaces from readJsonIfExists; a missing file
  // resolves to null. Anything else (wrong shape, mismatched schema
  // version, manual edits that dropped `sources`) lands here and would
  // previously vanish silently — log via debug so the user can see
  // when watermarks were dropped.
  //
  // When the on-disk schema version doesn't match the CLI's current
  // BACKFILL_STATE_SCHEMA_VERSION we deliberately drop every watermark.
  // The next sync-local-runner then re-parses every jsonl from scratch
  // and the server upserts via `replace: true`, so a CLI upgrade that
  // changed parser semantics (e.g. v2's dedup fix) silently rewrites
  // historical rollups without the user knowing.
  const statePath = backfillIncrementalStatePath(home)
  const state = await readJsonIfExists(statePath)
  if (state === null) {
    return { version: BACKFILL_STATE_SCHEMA_VERSION, sources: {} }
  }
  if (!isPlainObject(state) || !isPlainObject(state.sources)) {
    if (ctx) {
      debug(ctx, `backfill-state malformed at ${statePath}; ignoring watermarks\n`)
    }
    return { version: BACKFILL_STATE_SCHEMA_VERSION, sources: {} }
  }
  if (state.version !== BACKFILL_STATE_SCHEMA_VERSION) {
    if (ctx) {
      debug(ctx, `backfill-state version ${String(state.version)} at ${statePath} differs from current v${BACKFILL_STATE_SCHEMA_VERSION}; dropping watermarks so the next sync re-imports under the new parser\n`)
    }
    return { version: BACKFILL_STATE_SCHEMA_VERSION, sources: {} }
  }

  const sources: BackfillIncrementalState['sources'] = {}
  for (const source of ['codex', 'claude-code', 'opencode', 'pi', 'amp'] as const) {
    const item = state.sources[source]
    if (isPlainObject(item) && typeof item.watermarkTs === 'string' && !Number.isNaN(Date.parse(item.watermarkTs))) {
      sources[source] = { watermarkTs: item.watermarkTs }
    }
  }

  return { version: BACKFILL_STATE_SCHEMA_VERSION, sources }
}

async function updateBackfillIncrementalState(
  home: string,
  state: BackfillIncrementalState,
  selectedFilesBySource: Map<BackfillSourceId, BackfillSourceFile[]>,
): Promise<void> {
  for (const [source, files] of selectedFilesBySource.entries()) {
    const latest = maxTimestamp(files.map(f => f.modifiedAt))
    if (!latest) {
      continue
    }
    state.sources[source] = { watermarkTs: latest }
  }

  const statePath = backfillIncrementalStatePath(home)
  await mkdir(path.dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function readSyncLocalTriggerState(statePath: string): Promise<SyncLocalTriggerState> {
  const state = await readJsonIfExists(statePath)
  if (!isPlainObject(state)) {
    return { version: 1 }
  }
  const nextState: SyncLocalTriggerState = { version: 1 }
  if (typeof state.lastTriggeredAt === 'string') {
    nextState.lastTriggeredAt = state.lastTriggeredAt
  }
  if (typeof state.lastStartedAt === 'string') {
    nextState.lastStartedAt = state.lastStartedAt
  }
  if (typeof state.lastCompletedAt === 'string') {
    nextState.lastCompletedAt = state.lastCompletedAt
  }
  if (typeof state.lastExitCode === 'number' && Number.isFinite(state.lastExitCode)) {
    nextState.lastExitCode = state.lastExitCode
  }
  if (typeof state.pid === 'number' && Number.isFinite(state.pid)) {
    nextState.pid = state.pid
  }
  return nextState
}

async function writeSyncLocalTriggerState(statePath: string, state: SyncLocalTriggerState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function readSyncLocalLock(lockPath: string): Promise<SyncLocalLock | undefined> {
  const lock = await readJsonIfExists(lockPath)
  if (!isPlainObject(lock)) {
    return undefined
  }
  if (typeof lock.pid !== 'number' || !Number.isFinite(lock.pid) || typeof lock.startedAt !== 'string') {
    return undefined
  }
  return { pid: lock.pid, startedAt: lock.startedAt }
}

async function writeSyncLocalLock(lockPath: string, lock: SyncLocalLock): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true })
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
}

async function clearSyncLocalLock(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { force: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0); return true
  }
  catch {
    return false
  }
}

function maxTimestamp(values: string[]): string | undefined {
  let latest: string | undefined
  let latestMs = -Infinity
  for (const value of values) {
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed) || parsed <= latestMs) {
      continue
    }
    latest = value
    latestMs = parsed
  }
  return latest
}

// ── Sync local runner ──

function spawnSyncLocalRunner(input: {
  options: ParsedArgs
  ctx: RunContext
  home: string
  lockPath: string
  statePath: string
  triggeredAt: string
}) {
  const args = syncLocalRunnerArgs(input)
  const child = input.ctx.spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: process.env,
  })
  child.unref()
  return child
}

function syncLocalRunnerArgs(input: {
  options: ParsedArgs
  home: string
  lockPath: string
  statePath: string
  triggeredAt: string
}): string[] {
  const args = syncLocalRunnerEntryArgs(fileURLToPath(import.meta.url))
  args.push('sync-local-runner', '--home', input.home, '--lock-file', input.lockPath, '--state-file', input.statePath)
  if (stringOption(input.options['api-url'])) {
    args.push('--api-url', requiredOption(input.options, 'api-url'))
  }
  if (stringOption(input.options.token)) {
    args.push('--token', requiredOption(input.options, 'token'))
  }
  return args
}

export function syncLocalRunnerEntryArgs(cliPath: string): string[] {
  if (cliPath.endsWith('.ts')) {
    return ['--import', 'tsx', cliPath]
  }
  return [path.resolve(path.dirname(cliPath), '../bin/codetime.mjs')]
}

// ── Helpers ──

function resolveHome(options: ParsedArgs, ctx: RunContext): string {
  return path.resolve(stringOption(options.home) || ctx.env.HOME || os.homedir())
}

function requestedTargets(options: ParsedArgs): string[] {
  const value = options.target || options.targets
  if (!value) {
    return []
  }
  return valuesOption(value).flatMap(item => item.split(',')).map(t => t.trim()).filter(Boolean)
}

function normalizeBackfillSource(source: string): string {
  return source === 'claude' ? 'claude-code' : source
}

function requiredOption(options: ParsedArgs, name: string): string {
  const value = stringOption(options[name])
  if (!value) {
    throw new Error(`Missing required option: --${name}`)
  }
  return value
}

async function readHookPayload(stdin: AsyncIterable<unknown> & { isTTY?: boolean }): Promise<Record<string, unknown>> {
  const text = await readAll(stdin)
  if (!text.trim()) {
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : {}
  }
  catch {
    return {}
  }
}

async function readAll(readable: AsyncIterable<unknown> & { isTTY?: boolean }): Promise<string> {
  if (!readable || readable.isTTY) {
    return ''
  }
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function debug(ctx: RunContext, message: string): void {
  if (ctx.env.CODETIME_DEBUG) {
    write(ctx.stderr, message)
  }
}

// Single resolution path for API host + token. Per-command code should
// not reach into env / options directly — it should call this helper so
// precedence stays consistent across the CLI.
function resolveRemoteFromOptions(options: ParsedArgs, ctx: RunContext) {
  return resolveRemote({
    apiUrl: stringOption(options['api-url']),
    token: stringOption(options.token),
    env: ctx.env,
    fetch: ctx.fetch,
    homeOverride: stringOption(options.home),
  })
}

// ── token / machine ──

// Mask all but the last 4 chars of a token for display.
function maskToken(token: string): string {
  if (token.length <= 8) {
    return '***'
  }
  return `${token.slice(0, 3)}…${token.slice(-4)}`
}

async function tokenCommand(
  action: string | undefined,
  value: string | undefined,
  options: ParsedArgs,
  ctx: RunContext,
): Promise<number> {
  const verb = action || 'show'
  // Honor the global --home override so tests and ephemeral runs can
  // target a sandbox config without writing to ~/.codetime.
  const home = resolveHome(options, ctx)

  if (verb === 'set') {
    if (!value || value.trim().length === 0) {
      write(ctx.stderr, 'Usage: codetime token set <token> [--remote <url>]\n')
      return 1
    }
    const existing = readConfig(home)
    const remoteOverride = stringOption(options.remote) || stringOption(options['api-url'])
    writeConfig({
      ...existing,
      token: value.trim(),
      // Only update remoteUrl when explicitly given so users who pasted
      // a token but kept the default codetime.dev host don't lose any
      // earlier override.
      ...(remoteOverride ? { remoteUrl: remoteOverride } : {}),
    }, home)
    write(ctx.stdout, `Token saved (${maskToken(value.trim())}).\n`)
    return 0
  }

  if (verb === 'show') {
    const cfg = readConfig(home)
    if (!cfg.token) {
      write(ctx.stdout, 'No token set. Use `codetime login` or `codetime token set <token>`.\n')
      return 0
    }
    write(ctx.stdout, `remoteUrl: ${cfg.remoteUrl ?? '(default)'}\n`)
    write(ctx.stdout, `token:     ${maskToken(cfg.token)}\n`)
    if (cfg.machineId) {
      write(ctx.stdout, `machineId: ${cfg.machineId}\n`)
    }
    return 0
  }

  if (verb === 'clear') {
    const existing = readConfig(home)
    // Drop only token-bound fields; keep remoteUrl + machineName so a
    // re-login lands on the same host without re-typing it.
    const next: typeof existing = { ...existing }
    delete next.token
    delete next.machineId
    delete next.userId
    writeConfig(next, home)
    write(ctx.stdout, 'Token cleared.\n')
    return 0
  }

  write(ctx.stderr, `Unknown token action: ${verb}\nUsage: codetime token [set <token>|show|clear] [--remote <url>]\n`)
  return 1
}

async function machineCommand(action: string | undefined, options: ParsedArgs, ctx: RunContext): Promise<number> {
  const remote = resolveRemoteFromOptions(options, ctx)
  if (!remote || !remote.token) {
    write(ctx.stderr, 'machine command requires login (run `codetime login`).\n')
    return 1
  }
  const verb = action || 'ls'
  if (verb === 'ls' || verb === 'list') {
    const machines = await listMachines(remote)
    if (options.json) {
      write(ctx.stdout, `${JSON.stringify(machines, null, 2)}\n`)
      return 0
    }
    for (const m of machines) {
      write(ctx.stdout, `${m.id.slice(0, 8)}  ${m.displayName.padEnd(28)}  ${m.hostname}  last:${m.lastSeenAt ?? 'never'}\n`)
    }
    return 0
  }
  if (verb === 'rename') {
    // Defaults: --id falls back to the local machine-id (the one we
    // send on every ingest), so a fresh CLI install can self-rename
    // without first running `machine ls` to copy the UUID.
    const home = resolveHome(options, ctx)
    const id = stringOption(options.id) || ensureLocalMachineId(home)
    const name = stringOption(options.name)
    if (!name) {
      write(ctx.stderr, '`machine rename` requires --name\n')
      return 1
    }
    const updated = await renameMachine(remote, id, name)
    write(ctx.stdout, `Renamed: ${updated.id} → ${updated.displayName}\n`)
    return 0
  }
  if (verb === 'delete' || verb === 'rm') {
    const id = stringOption(options.id)
    if (!id) {
      write(ctx.stderr, '`machine delete` requires --id\n')
      return 1
    }
    const { deletedSessions } = await deleteMachine(remote, id)
    write(ctx.stdout, `Deleted: ${id} (${deletedSessions} rollups dropped)\n`)
    return 0
  }
  write(ctx.stderr, `Unknown machine action: ${verb}\n`)
  return 1
}

function write(stream: WritableLike, text: string): void {
  stream.write(text)
}

function helpText(): string {
  return `codetime ${PACKAGE_VERSION}

Usage:
  codetime detect [--json] [--home <path>]
  codetime install [--target codex,claude,opencode,pi] [--all] [--dry-run] [--force] [--home <path>]
  codetime hook --agent <name>
  codetime backfill discover|plan|import|verify --source codex|claude-code|opencode|pi|all --dry-run [--json] [--batch-size <count>]
  codetime token set <token>
  codetime token show
  codetime token clear

Setup:
  Copy your upload token from https://codetime.dev/dashboard/settings,
  then run: codetime token set <token>

Commands:
  detect    Show supported local targets and install status.
  install   Install integration files into detected or requested targets.
  hook      Read agent hook JSON from stdin and report a throttled event.
  backfill  Discover local history and create metadata-only import plans.
  token     Set, show, or clear the persisted API token.
  machine   List your machines (read-only).
  version   Print CLI version.
  help      Show this help.

Global options:
  --api-url <url>   Override the API host for this invocation.
  --token <token>   Bearer token for this invocation (overrides config).

Token precedence (highest first):
  --token flag  >  CODETIME_TOKEN env  >  saved config (~/.codetime/config.json).

Environment:
  CODETIME_API_URL        Defaults to ${DEFAULT_API_URL}
  CODETIME_TOKEN          Bearer token for the API
`
}
