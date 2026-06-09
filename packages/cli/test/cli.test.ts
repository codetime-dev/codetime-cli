import type { RunContext } from '../src/lib/types.ts'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { createCodexAdapter } from '../src/adapters/codex.ts'
import { run, syncLocalRunnerEntryArgs } from '../src/cli.ts'

test('detect reports installed Codex hook', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  await run(['install', '--target', 'codex', '--home', home], testContext())

  let output = ''
  const exitCode = await run(['detect', '--json', '--home', home], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  const parsed = JSON.parse(output)
  const codex = parsed.targets.find((target: { id: string }) => target.id === 'codex')
  assert.equal(codex.installed, true)
})

test('detect only marks Codex installed when codetime hook exists', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  await mkdir(path.join(home, '.codex'), { recursive: true })
  await writeFile(path.join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }), 'utf8')

  let output = ''
  const exitCode = await run(['detect', '--json', '--home', home], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  const parsed = JSON.parse(output)
  const codex = parsed.targets.find((target: { id: string }) => target.id === 'codex')
  assert.equal(codex.detected, true)
  assert.equal(codex.installed, false)
})

test('install writes Codex hook without a skill', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const exitCode = await run(['install', '--target', 'codex', '--home', home], testContext())

  assert.equal(exitCode, 0)
  const skillPath = path.join(home, '.codex', 'skills', 'codetime', 'SKILL.md')
  const hooksPath = path.join(home, '.codex', 'hooks.json')
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8'))

  await assert.rejects(readFile(skillPath, 'utf8'), { code: 'ENOENT' })
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'codetime hook --agent codex')
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, 'codetime hook --agent codex')
  assert.equal(hooks.hooks.PostToolUse[0].hooks[0].command, 'codetime hook --agent codex')
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'codetime hook --agent codex')
})

test('hook triggers a sync-local-runner without parsing the payload', async () => {
  // Verifies the trigger contract: the hook spawns sync-local-runner (the
  // real upload path) and persists state/lock files. Payload contents are
  // not inspected — backfill re-derives all events from session files.
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const spawns: Array<{ command: string, args: string[] }> = []
  const stdin = Readable.from([JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    cwd: path.join(home, 'project'),
    session_id: 's1',
  })])

  const exitCode = await run(['hook', '--agent', 'codex', '--home', home], testContext({
    stdin,
    spawn: ((command: string, args: string[]) => {
      spawns.push({ command, args })
      return { pid: 43_210, unref() {} } as never
    }) as unknown as RunContext['spawn'],
  }))

  assert.equal(exitCode, 0)
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].args.includes('sync-local-runner'), true)
  const state = JSON.parse(await readFile(path.join(home, '.codetime', 'sync-local-trigger.json'), 'utf8'))
  const lock = JSON.parse(await readFile(path.join(home, '.codetime', 'sync-local-trigger.lock'), 'utf8'))
  assert.equal(typeof state.lastTriggeredAt, 'string')
  assert.equal(lock.pid, 43_210)
})

test('hook --dry-run echoes the payload without triggering backfill', async () => {
  const spawns: number[] = []
  const stdin = Readable.from([JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'src/index.ts' },
  })])
  let output = ''

  const exitCode = await run(['hook', '--agent', 'claude', '--dry-run'], testContext({
    stdin,
    spawn: () => {
      spawns.push(1)
      return { pid: 1, unref() {} } as never
    },
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  assert.equal(spawns.length, 0, 'dry-run must not spawn anything')
  const result = JSON.parse(output)
  assert.equal(result.agent, 'claude')
  assert.equal(result.wouldTrigger, 'backfill')
  assert.equal(result.received.hook_event_name, 'PostToolUse')
  assert.equal(result.received.tool_name, 'Read')
})

test('sync-local-runner entry args use the bin entrypoint for built output', () => {
  assert.deepEqual(syncLocalRunnerEntryArgs('/repo/packages/cli/src/cli.ts'), [
    '--import',
    'tsx',
    '/repo/packages/cli/src/cli.ts',
  ])
  assert.deepEqual(syncLocalRunnerEntryArgs('/repo/packages/cli/dist/cli.js'), [
    '/repo/packages/cli/bin/codetime.mjs',
  ])
})

test('sync-local-trigger throttles repeated triggers', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  await mkdir(path.join(home, '.codetime'), { recursive: true })
  await writeFile(path.join(home, '.codetime', 'sync-local-trigger.json'), JSON.stringify({
    version: 1,
    lastTriggeredAt: new Date().toISOString(),
  }), 'utf8')
  let output = ''

  const exitCode = await run(['sync-local-trigger', '--home', home, '--min-interval', '60', '--json'], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  const result = JSON.parse(output)
  assert.equal(result.status, 'throttled')
})

test('sync-local-trigger detects an already running sync', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  await mkdir(path.join(home, '.codetime'), { recursive: true })
  await writeFile(path.join(home, '.codetime', 'sync-local-trigger.lock'), JSON.stringify({
    pid: process.pid,
    startedAt: '2026-05-02T00:00:00.000Z',
  }), 'utf8')
  let output = ''

  const exitCode = await run(['sync-local-trigger', '--home', home, '--json'], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  const result = JSON.parse(output)
  assert.equal(result.status, 'already-running')
  assert.equal(result.pid, process.pid)
})

test('sync-local-runner honors explicit state and lock file paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const statePath = path.join(home, 'custom-state.json')
  const lockPath = path.join(home, 'custom.lock')
  const exitCode = await run([
    'sync-local-runner',
    '--home',
    home,
    '--lock-file',
    lockPath,
    '--state-file',
    statePath,
    '--json',
  ], testContext({
    stdout: { write() {} },
    fetch: async (_url, init) => {
      const rollups = JSON.parse(String(init?.body)).rollups
      return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(typeof state.lastStartedAt, 'string')
  assert.equal(typeof state.lastCompletedAt, 'string')
  assert.equal(state.lastExitCode, 0)
  await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' })
})

test('backfill dry-run reports local history candidates without importing', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  await mkdir(path.join(home, '.codex', 'sessions'), { recursive: true })
  await writeFile(path.join(home, '.codex', 'sessions', 'session.jsonl'), JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-04-29T00:00:00.000Z',
    payload: {
      id: 's1',
      cwd: path.join(home, 'project'),
      model_provider: 'openai',
    },
  }), 'utf8')

  let output = ''
  const exitCode = await run(['backfill', 'plan', '--source', 'codex', '--dry-run', '--json', '--home', home], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  const result = JSON.parse(output)
  assert.equal(result.importRun.source, 'codex')
  assert.equal(result.candidates[0].exists, true)
  assert.match(result.plannedEvents[0].eventId, /^evt_[0-9a-f]{24}$/)
  assert.match(result.plannedEvents[0].payloadHash, /^sha256:/)
})

test('backfill plan parses Codex sessions without leaking transcript text', async () => {
  const home = await createCodexBackfillHome()

  let output = ''
  const exitCode = await run(['backfill', 'plan', '--source', 'codex', '--dry-run', '--json', '--home', home], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  assert.equal(output.includes('secret prompt'), false)
  assert.equal(output.includes('secret command'), false)
  assert.equal(output.includes('secret diff'), false)

  const result = JSON.parse(output)
  const types = new Set(result.plannedEvents.map((event: { type: string }) => event.type))
  assert.ok(types.has('session.started'))
  assert.ok(types.has('prompt.submitted'))
  assert.ok(types.has('model.usage'))
  assert.ok(types.has('command.completed'))
  assert.ok(types.has('file.read'))
  assert.ok(types.has('file.changed'))
})

test('backfill plan text output is bounded', async () => {
  const home = await createCodexBackfillHome()

  let output = ''
  const exitCode = await run(['backfill', 'plan', '--source', 'codex', '--dry-run', '--home', home], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  assert.match(output, /planned \d+/)
  assert.match(output, /events codex:/)
  assert.match(output, /sample/)
  assert.match(output, /use --json for full details/)
  assert.equal(output.includes('secret prompt'), false)
  assert.equal(output.split('\n').length < 20, true)
})

test('backfill plan honors the limit option', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const sessionsDir = path.join(home, '.codex', 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(path.join(sessionsDir, 'a.jsonl'), JSON.stringify({
    timestamp: '2026-04-29T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'a', cwd: path.join(home, 'project-a') },
  }), 'utf8')
  await writeFile(path.join(sessionsDir, 'b.jsonl'), JSON.stringify({
    timestamp: '2026-04-29T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'b', cwd: path.join(home, 'project-b') },
  }), 'utf8')

  let output = ''
  const exitCode = await run(['backfill', 'plan', '--source', 'codex', '--dry-run', '--json', '--home', home, '--limit', '1'], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  const result = JSON.parse(output)
  assert.equal(result.candidates[0].entries, 2)
  assert.equal(result.plannedEvents.length, 1)
})

test('Codex parser dedupes consecutive token_count events with identical last_token_usage', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const sessionsDir = path.join(home, '.codex', 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const dupUsage = {
    info: {
      model_context_window: 128_000,
      last_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 0,
        total_tokens: 120,
      },
    },
  }
  const freshUsage = {
    info: {
      model_context_window: 128_000,
      last_token_usage: {
        input_tokens: 150,
        cached_input_tokens: 50,
        output_tokens: 30,
        reasoning_output_tokens: 0,
        total_tokens: 180,
      },
    },
  }
  await writeFile(path.join(sessionsDir, 'dup.jsonl'), [
    { timestamp: '2026-04-29T00:00:00.000Z', type: 'session_meta', payload: { id: 's-dup', cwd: path.join(home, 'project'), model_provider: 'openai' } },
    { timestamp: '2026-04-29T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', ...dupUsage } },
    { timestamp: '2026-04-29T00:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', ...dupUsage } },
    { timestamp: '2026-04-29T00:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', ...dupUsage } },
    { timestamp: '2026-04-29T00:00:04.000Z', type: 'event_msg', payload: { type: 'token_count', ...freshUsage } },
  ].map(item => JSON.stringify(item)).join('\n'), 'utf8')

  let capturedBody = ''
  const exitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test'], testContext({
    fetch: async (_url, init) => {
      capturedBody = String(init?.body)
      const rollups = JSON.parse(capturedBody).rollups
      return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  const rollup = JSON.parse(capturedBody).rollups[0]
  const modelRollup = rollup.modelRollups[0]
  assert.equal(modelRollup.callCount, 2)
  assert.equal(modelRollup.inputTokens, 100 + 150)
  assert.equal(modelRollup.outputTokens, 20 + 30)
  assert.equal(modelRollup.totalTokens, 120 + 180)
})

test('Codex parser ignores replayed parent session_meta in forked rollouts', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const sessionsDir = path.join(home, '.codex', 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(path.join(sessionsDir, 'fork.jsonl'), [
    { timestamp: '2026-04-29T00:00:00.000Z', type: 'session_meta', payload: { id: 'child-id', forked_from_id: 'parent-id', cwd: path.join(home, 'project'), model_provider: 'openai' } },
    { timestamp: '2026-04-29T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: '2026-04-29T00:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 128_000, last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0, total_tokens: 14 } } } },
    { timestamp: '2026-04-29T00:00:03.000Z', type: 'session_meta', payload: { id: 'parent-id', cwd: path.join(home, 'project'), model_provider: 'openai' } },
    { timestamp: '2026-04-29T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 4000 } },
  ].map(item => JSON.stringify(item)).join('\n'), 'utf8')

  let capturedBody = ''
  const exitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test'], testContext({
    fetch: async (_url, init) => {
      capturedBody = String(init?.body)
      const rollups = JSON.parse(capturedBody).rollups
      return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  const rollups = JSON.parse(capturedBody).rollups
  assert.equal(rollups.length, 1)
  assert.equal(rollups[0].sessionId, 'child-id')
})

test('backfill import sends parsed Codex events and counts API results', async () => {
  const home = await createCodexBackfillHome()
  const calls: Array<{ url: string, body: string }> = []
  let output = ''

  const exitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test', '--json'], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
    fetch: async (url, init) => {
      const body = String(init?.body)
      const rollups = JSON.parse(body).rollups
      calls.push({ url: String(url), body })
      return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v3\/agent\/ingest$/)
  assert.equal(calls.some(call => call.body.includes('secret prompt')), false)
  assert.equal(calls.some(call => call.body.includes('secret command')), false)
  assert.equal(calls.some(call => call.body.includes('secret diff')), false)

  const rollups = JSON.parse(calls[0].body).rollups
  const result = JSON.parse(output)
  assert.equal(result.planned, rollups.length)
  assert.equal(result.sourceEvents > rollups.length, true)
  assert.equal(result.inserted, rollups.length)
  assert.equal(result.skipped, 0)

  const rollup = rollups[0]
  assert.equal(rollup.fileRollups.some((file: { displayPath: string }) => file.displayPath === 'src/secret.ts'), true)
  assert.equal(rollup.fileRollups.some((file: { displayPath: string }) => file.displayPath === 'src/readme.ts'), true)
  const changedFile = rollup.fileRollups.find((file: { displayPath: string }) => file.displayPath === 'src/secret.ts')
  assert.equal(changedFile.linesAdded, 1)
  assert.equal(changedFile.linesRemoved, 1)
})

test('backfill import text output reports bounded progress', async () => {
  const home = await createCodexBackfillHome()
  let output = ''

  const exitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test', '--batch-size', '2'], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
    fetch: async (_url, init) => {
      const rollups = JSON.parse(String(init?.body)).rollups
      return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  // Progress now renders as a bar (one line per source, overwritten via
  // \r), so we assert on the per-source label and the data the bar's
  // tick/finalize messages embed rather than the old text milestones.
  assert.match(output, /codex\s+\[.+\] 100% · \d+\/\d+ files, \d+ events/)
  assert.match(output, /rollup \d+ from \d+ events/)
  assert.match(output, /upload\s+\[.+\] 100% · \d+\/\d+ batches, inserted \d+/)
  assert.match(output, /inserted \d+/)
  assert.equal(output.split('\n').length < 30, true)
})

test('backfill import can skip API conflicts', async () => {
  const home = await createCodexBackfillHome()
  let sawReplace = true

  const exitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test', '--skip-conflicts'], testContext({
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      sawReplace = body.replace === true
      const rollups = body.rollups
      return Response.json({ inserted: 0, skipped: 0, conflicts: rollups.length, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  assert.equal(sawReplace, false)
})

test('backfill import replaces conflicts by default for rollup uploads', async () => {
  const home = await createCodexBackfillHome()
  let sawReplace = false

  const exitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test'], testContext({
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      sawReplace = body.replace === true
      const rollups = body.rollups
      return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  assert.equal(sawReplace, true)
})

test('backfill import handles large Codex event batches', async () => {
  const home = await createLargeCodexBackfillHome(3, 50_000)
  let output = ''
  let batches = 0

  const exitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test', '--batch-size', '50000', '--json'], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
    fetch: async (_url, init) => {
      batches += 1
      const rollups = JSON.parse(String(init?.body)).rollups
      return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  const result = JSON.parse(output)
  assert.equal(result.planned, 3)
  assert.equal(result.sourceEvents, 150_000)
  assert.equal(result.inserted, 3)
  assert.equal(batches, 1)
})

test('backfill import skips unchanged session files after the watermark advances', async () => {
  const home = await createIncrementalCodexBackfillHome()
  const calls: Array<{ url: string, body: string }> = []

  const fetch: RunContext['fetch'] = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) })
    const rollups = JSON.parse(String(init?.body)).rollups
    return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
  }

  const firstExitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test', '--json'], testContext({ fetch }))
  assert.equal(firstExitCode, 0)
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].body).rollups.length, 2)

  calls.length = 0
  const secondExitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test', '--json'], testContext({ fetch }))
  assert.equal(secondExitCode, 0)
  assert.equal(calls.length, 0)
})

test('backfill import reparses a changed session file from its earliest event', async () => {
  const home = await createIncrementalCodexBackfillHome()
  const calls: Array<{ url: string, body: string }> = []

  const fetch: RunContext['fetch'] = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) })
    const rollups = JSON.parse(String(init?.body)).rollups
    return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
  }

  const firstExitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test', '--json'], testContext({ fetch }))
  assert.equal(firstExitCode, 0)

  calls.length = 0
  const sessionPath = path.join(home, '.codex', 'sessions', '2026', '04', '29', 'rollout-b.jsonl')
  await writeFile(sessionPath, [
    {
      timestamp: '2026-04-28T23:59:58.000Z',
      type: 'session_meta',
      payload: {
        id: 'session-b',
        cwd: path.join(home, 'project-b'),
        model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-04-29T00:01:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-b',
      },
    },
    {
      timestamp: '2026-04-29T00:01:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'prompt b',
      },
    },
    {
      timestamp: '2026-04-29T00:01:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-b',
        duration_ms: 2000,
      },
    },
  ].map(item => JSON.stringify(item)).join('\n'), 'utf8')
  await utimes(sessionPath, new Date('2026-04-29T00:10:00.000Z'), new Date('2026-04-29T00:10:00.000Z'))

  const secondExitCode = await run(['backfill', 'import', '--source', 'codex', '--home', home, '--api-url', 'http://example.test', '--json'], testContext({ fetch }))
  assert.equal(secondExitCode, 0)
  assert.equal(calls.length, 1)

  const rollups = JSON.parse(calls[0].body).rollups
  assert.equal(rollups.length, 1)
  assert.equal(rollups[0].sessionId, 'session-b')
  assert.equal(rollups[0].startedAt, '2026-04-28T23:59:58.000Z')
})

test('backfill plan parses Claude Code sessions without leaking transcript text', async () => {
  const home = await createClaudeBackfillHome()

  let output = ''
  const exitCode = await run(['backfill', 'plan', '--source', 'claude-code', '--dry-run', '--json', '--home', home], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  assert.equal(output.includes('secret prompt'), false)
  assert.equal(output.includes('secret command'), false)
  assert.equal(output.includes('secret file content'), false)
  assert.equal(output.includes('secret subagent prompt'), false)

  const result = JSON.parse(output)
  assert.equal(result.importRun.source, 'claude-code')
  const types = new Set(result.plannedEvents.map((event: { type: string }) => event.type))
  assert.ok(types.has('session.started'))
  assert.ok(types.has('prompt.submitted'))
  assert.ok(types.has('model.usage'))
  assert.ok(types.has('tool.started'))
  assert.ok(types.has('tool.completed'))
  assert.ok(types.has('command.completed'))
  assert.ok(types.has('file.read'))
  assert.ok(types.has('file.changed'))
  assert.ok(types.has('subagent.started'))
  assert.ok(types.has('subagent.ended'))
})

test('backfill import sends parsed Claude Code events and counts API results', async () => {
  const home = await createClaudeBackfillHome()
  const calls: Array<{ url: string, body: string }> = []
  let output = ''

  const exitCode = await run(['backfill', 'import', '--source', 'claude-code', '--home', home, '--api-url', 'http://example.test', '--json'], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
    fetch: async (url, init) => {
      const body = String(init?.body)
      const rollups = JSON.parse(body).rollups
      calls.push({ url: String(url), body })
      return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v3\/agent\/ingest$/)
  assert.equal(calls[0].body.includes('secret prompt'), false)
  assert.equal(calls[0].body.includes('secret command'), false)
  assert.equal(calls[0].body.includes('secret file content'), false)
  assert.equal(calls[0].body.includes('secret subagent prompt'), false)

  const rollups = JSON.parse(calls[0].body).rollups
  const result = JSON.parse(output)
  assert.equal(result.source, 'claude-code')
  assert.equal(result.planned, rollups.length)
  assert.equal(result.inserted, rollups.length)

  const rollup = rollups[0]
  assert.equal(rollup.project, 'codetime')
  assert.equal(rollup.fileRollups.some((file: { displayPath: string }) => file.displayPath === 'src/readme.ts'), true)
  const fileChanged = rollup.fileRollups.find((file: { displayPath: string }) => file.displayPath === 'src/generated.ts')
  assert.equal(fileChanged.linesAdded, 2)
  const modelRollup = rollup.modelRollups[0]
  assert.equal(modelRollup.inputTokens, 17)
  assert.equal(modelRollup.cachedInputTokens, 7)
  assert.equal(modelRollup.cacheCreationInputTokens, 2)
  assert.equal(modelRollup.cacheReadInputTokens, 5)
  assert.equal(modelRollup.outputTokens, 4)
  assert.equal(modelRollup.totalTokens, 21)
})

test('backfill verify reports placeholder status for import runs', async () => {
  let output = ''
  const exitCode = await run(['backfill', 'verify', '--import-run', 'import_123', '--json'], testContext({
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  const result = JSON.parse(output)
  assert.equal(result.importRunId, 'import_123')
  assert.equal(result.status, 'not-implemented')
})

async function createCodexBackfillHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const sessionsDir = path.join(home, '.codex', 'sessions', '2026', '04', '29')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(path.join(sessionsDir, 'rollout-2026-04-29T00-00-00-000Z-12345678-1234-1234-1234-123456789abc.jsonl'), [
    {
      timestamp: '2026-04-29T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: '12345678-1234-1234-1234-123456789abc',
        cwd: path.join(home, 'project'),
        model_provider: 'openai',
      },
    },
    {
      timestamp: '2026-04-29T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-1',
      },
    },
    {
      timestamp: '2026-04-29T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'secret prompt',
      },
    },
    {
      timestamp: '2026-04-29T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 128_000,
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 4,
            reasoning_output_tokens: 1,
            total_tokens: 14,
          },
        },
      },
    },
    {
      timestamp: '2026-04-29T00:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        call_id: 'call-read',
        arguments: JSON.stringify({
          cmd: 'sed -n \'1,20p\' src/readme.ts',
          workdir: path.join(home, 'project'),
        }),
      },
    },
    {
      timestamp: '2026-04-29T00:00:04.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: 'secret command',
      },
    },
    {
      timestamp: '2026-04-29T00:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: 'call-1',
        turn_id: 'turn-1',
        command: ['sh', '-lc', 'secret command'],
        exit_code: 0,
        duration: {
          secs: 1,
          nanos: 250_000_000,
        },
      },
    },
    {
      timestamp: '2026-04-29T00:00:06.000Z',
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'call-2',
        turn_id: 'turn-1',
        success: true,
        changes: {
          'src/secret.ts': {
            type: 'update',
            unified_diff: [
              '--- a/src/secret.ts',
              '+++ b/src/secret.ts',
              '-const value = \'\'',
              '+const value = \'secret diff\'',
            ].join('\n'),
          },
        },
      },
    },
    {
      timestamp: '2026-04-29T00:00:07.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        duration_ms: 7000,
      },
    },
  ].map(item => JSON.stringify(item)).join('\n'), 'utf8')
  return home
}

async function createIncrementalCodexBackfillHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const sessionsDir = path.join(home, '.codex', 'sessions', '2026', '04', '29')
  await mkdir(sessionsDir, { recursive: true })

  const files = [
    {
      name: 'rollout-a.jsonl',
      mtime: '2026-04-29T00:05:00.000Z',
      lines: [
        {
          timestamp: '2026-04-29T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'session-a',
            cwd: path.join(home, 'project-a'),
            model_provider: 'openai',
          },
        },
        {
          timestamp: '2026-04-29T00:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-a',
          },
        },
        {
          timestamp: '2026-04-29T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'prompt a',
          },
        },
        {
          timestamp: '2026-04-29T00:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-a',
            duration_ms: 2000,
          },
        },
      ],
    },
    {
      name: 'rollout-b.jsonl',
      mtime: '2026-04-29T00:06:00.000Z',
      lines: [
        {
          timestamp: '2026-04-29T00:01:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'session-b',
            cwd: path.join(home, 'project-b'),
            model_provider: 'openai',
          },
        },
        {
          timestamp: '2026-04-29T00:01:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-b',
          },
        },
        {
          timestamp: '2026-04-29T00:01:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'prompt b',
          },
        },
        {
          timestamp: '2026-04-29T00:01:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-b',
            duration_ms: 2000,
          },
        },
      ],
    },
  ]

  for (const file of files) {
    const filePath = path.join(sessionsDir, file.name)
    await writeFile(filePath, file.lines.map(item => JSON.stringify(item)).join('\n'), 'utf8')
    await utimes(filePath, new Date(file.mtime), new Date(file.mtime))
  }

  return home
}

async function createLargeCodexBackfillHome(fileCount: number, eventsPerFile: number) {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const sessionsDir = path.join(home, '.codex', 'sessions', '2026', '04', '29')
  await mkdir(sessionsDir, { recursive: true })
  const line = JSON.stringify({
    timestamp: '2026-04-29T00:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: 'x',
    },
  })

  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(path.join(sessionsDir, `large-${index}.jsonl`), `${Array.from({ length: eventsPerFile }).fill(line).join('\n')}\n`, 'utf8')
  }

  return home
}

async function createClaudeBackfillHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const projectRoot = path.join(home, 'codetime')
  const sessionsDir = path.join(home, '.claude', 'projects', path.resolve(projectRoot).split(path.sep).join('-'))
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(path.join(sessionsDir, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.jsonl'), [
    {
      type: 'user',
      sessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      uuid: 'turn-1',
      cwd: path.join(home, 'codetime'),
      timestamp: '2026-04-29T00:00:00.000Z',
      message: {
        role: 'user',
        content: 'secret prompt',
      },
    },
    {
      type: 'assistant',
      sessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      uuid: 'assistant-1',
      parentUuid: 'turn-1',
      cwd: path.join(home, 'codetime'),
      timestamp: '2026-04-29T00:00:01.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 5,
          output_tokens: 4,
        },
        content: [
          {
            type: 'tool_use',
            id: 'toolu_read',
            name: 'Read',
            input: {
              file_path: 'src/readme.ts',
              limit: 20,
            },
          },
        ],
      },
    },
    {
      type: 'user',
      sessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      uuid: 'result-1',
      parentUuid: 'assistant-1',
      cwd: path.join(home, 'codetime'),
      timestamp: '2026-04-29T00:00:02.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read',
            content: 'secret file content',
          },
        ],
      },
      toolUseResult: {
        type: 'text',
        file: {
          filePath: 'src/readme.ts',
          content: 'secret file content',
          numLines: 2,
          totalLines: 2,
        },
      },
    },
    {
      type: 'assistant',
      sessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      uuid: 'assistant-2',
      parentUuid: 'result-1',
      cwd: path.join(home, 'codetime'),
      timestamp: '2026-04-29T00:00:03.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_bash',
            name: 'Bash',
            input: {
              command: 'cat src/readme.ts && echo secret command',
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_write',
            name: 'Write',
            input: {
              file_path: 'src/generated.ts',
              content: 'secret file content\nsecond line',
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_agent',
            name: 'Agent',
            input: {
              subagent_type: 'explorer',
              prompt: 'secret subagent prompt',
            },
          },
        ],
      },
    },
    {
      type: 'user',
      sessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      uuid: 'result-2',
      parentUuid: 'assistant-2',
      cwd: path.join(home, 'codetime'),
      timestamp: '2026-04-29T00:00:04.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_bash',
            content: 'secret command output',
          },
        ],
      },
      toolUseResult: {
        stdout: 'secret command output',
        stderr: '',
        interrupted: false,
      },
    },
    {
      type: 'user',
      sessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      uuid: 'result-3',
      parentUuid: 'assistant-2',
      cwd: path.join(home, 'codetime'),
      timestamp: '2026-04-29T00:00:05.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_write',
            content: 'created',
          },
        ],
      },
      toolUseResult: {
        type: 'create',
        filePath: 'src/generated.ts',
        content: 'secret file content\nsecond line',
      },
    },
    {
      type: 'user',
      sessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      uuid: 'result-4',
      parentUuid: 'assistant-2',
      cwd: path.join(home, 'codetime'),
      timestamp: '2026-04-29T00:00:06.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_agent',
            content: 'done',
          },
        ],
      },
      toolUseResult: {
        agentId: 'agent-1',
        agentType: 'explorer',
        status: 'completed',
        totalDurationMs: 3000,
        totalTokens: 30,
        totalToolUseCount: 2,
        usage: {
          input_tokens: 20,
          output_tokens: 10,
        },
      },
    },
  ].map(item => JSON.stringify(item)).join('\n'), 'utf8')
  return home
}

function testContext(overrides: Partial<RunContext> = {}): Partial<RunContext> {
  return {
    env: { HOME: tmpdir() },
    stdin: Readable.from([]),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    fetch: (async () => Response.json({ data: {} }, { status: 201 })) as unknown as RunContext['fetch'],
    spawn: (() => ({ pid: 12_345, unref() {} })) as unknown as RunContext['spawn'],
    ...overrides,
  }
}

// ── Config override env vars ──
//
// Each agent supports relocating its config/data directory. The CLI must honor
// the same env vars users set on the agent itself, otherwise codetime stops
// seeing sessions the moment someone moves their config dir.

async function detectTargets(home: string, env: Record<string, string>): Promise<Record<string, { detectPath: string, installedPath: string, installed: boolean, detected: boolean }>> {
  let output = ''
  const exitCode = await run(['detect', '--json', '--home', home], testContext({
    env: { HOME: home, ...env },
    stdout: { write: (text: string) => {
      output += text
    } },
  }))
  assert.equal(exitCode, 0)
  const parsed = JSON.parse(output) as { targets: Array<{ id: string, detectPath: string, installedPath: string, installed: boolean, detected: boolean }> }
  return Object.fromEntries(parsed.targets.map(t => [t.id, t]))
}

test('CLAUDE_CONFIG_DIR relocates Claude Code detect, install, and source paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const claudeDir = await mkdtemp(path.join(tmpdir(), 'claude-config-'))

  const targets = await detectTargets(home, { CLAUDE_CONFIG_DIR: claudeDir })
  assert.equal(targets['claude-code'].detectPath, claudeDir)
  assert.equal(targets['claude-code'].installedPath, path.join(claudeDir, 'settings.json'))

  const exitCode = await run(['install', '--target', 'claude-code', '--home', home], testContext({
    env: { HOME: home, CLAUDE_CONFIG_DIR: claudeDir },
  }))
  assert.equal(exitCode, 0)
  const settings = JSON.parse(await readFile(path.join(claudeDir, 'settings.json'), 'utf8'))
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'codetime hook --agent claude')
  await assert.rejects(readFile(path.join(home, '.claude', 'settings.json'), 'utf8'), { code: 'ENOENT' })
})

test('CODEX_HOME relocates Codex detect, install, and source paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const codexHome = await mkdtemp(path.join(tmpdir(), 'codex-home-'))

  const targets = await detectTargets(home, { CODEX_HOME: codexHome })
  assert.equal(targets.codex.detectPath, codexHome)
  assert.equal(targets.codex.installedPath, path.join(codexHome, 'hooks.json'))

  const exitCode = await run(['install', '--target', 'codex', '--home', home], testContext({
    env: { HOME: home, CODEX_HOME: codexHome },
  }))
  assert.equal(exitCode, 0)
  const hooks = JSON.parse(await readFile(path.join(codexHome, 'hooks.json'), 'utf8'))
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'codetime hook --agent codex')
  await assert.rejects(readFile(path.join(home, '.codex', 'hooks.json'), 'utf8'), { code: 'ENOENT' })
})

test('PI_CODING_AGENT_DIR relocates Pi detect and install paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const piDir = await mkdtemp(path.join(tmpdir(), 'pi-agent-'))

  const targets = await detectTargets(home, { PI_CODING_AGENT_DIR: piDir })
  assert.equal(targets.pi.detectPath, piDir)
  assert.equal(targets.pi.installedPath, path.join(piDir, 'extensions', 'codetime.ts'))

  const exitCode = await run(['install', '--target', 'pi', '--home', home], testContext({
    env: { HOME: home, PI_CODING_AGENT_DIR: piDir },
  }))
  assert.equal(exitCode, 0)
  const extension = await readFile(path.join(piDir, 'extensions', 'codetime.ts'), 'utf8')
  assert.match(extension, /"codetime"/)
  assert.match(extension, /"--agent", "pi"/)
})

test('PI_CODING_AGENT_SESSION_DIR relocates only the Pi sessions dir, not the install path', async () => {
  // Plan a backfill against a relocated sessions dir while leaving the agent
  // dir at its default — this proves PI_CODING_AGENT_SESSION_DIR is honored
  // independently for backfill source discovery.
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'pi-sessions-'))
  // Default install path should still resolve under ~/.pi/agent.
  const targets = await detectTargets(home, { PI_CODING_AGENT_SESSION_DIR: sessionsDir })
  assert.equal(targets.pi.detectPath, path.join(home, '.pi', 'agent'))

  let output = ''
  const exitCode = await run([
    'backfill',
    'discover',
    '--source',
    'pi',
    '--home',
    home,
    '--json',
    '--include-source-path',
  ], testContext({
    env: { HOME: home, PI_CODING_AGENT_SESSION_DIR: sessionsDir },
    stdout: { write: (text: string) => {
      output += text
    } },
  }))
  assert.equal(exitCode, 0)
  const plan = JSON.parse(output)
  const piCandidate = plan.candidates.find((c: { source: string }) => c.source === 'pi')
  assert.ok(piCandidate, 'expected a pi backfill candidate')
  assert.equal(piCandidate.path, sessionsDir)
})

test('OPENCODE_CONFIG_DIR relocates OpenCode install path', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const opencodeDir = await mkdtemp(path.join(tmpdir(), 'opencode-config-'))

  const targets = await detectTargets(home, { OPENCODE_CONFIG_DIR: opencodeDir })
  assert.equal(targets.opencode.detectPath, opencodeDir)
  assert.equal(targets.opencode.installedPath, path.join(opencodeDir, 'plugins', 'codetime.mjs'))

  const exitCode = await run(['install', '--target', 'opencode', '--home', home], testContext({
    env: { HOME: home, OPENCODE_CONFIG_DIR: opencodeDir },
  }))
  assert.equal(exitCode, 0)
  const plugin = await readFile(path.join(opencodeDir, 'plugins', 'codetime.mjs'), 'utf8')
  assert.match(plugin, /codetime hook --agent opencode/)
})

const SAMPLE_CODEX_SESSION = [
  JSON.stringify({ timestamp: '2026-05-13T09:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
  JSON.stringify({
    timestamp: '2026-05-13T09:01:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 150 },
        total_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 150 },
      },
    },
  }),
].join('\n')

test('codex parser does NOT append -fast when config.toml has service_tier="fast" but the session has no per-turn evidence', async () => {
  // Regression: prior versions read CODEX_HOME/config.toml once per backfill
  // and stamped every historical model.usage with -fast, which retroactively
  // re-classified old standard-tier sessions as fast whenever the user later
  // enabled fast. Only per-turn evidence inside the session counts now.
  const codexHome = await mkdtemp(path.join(tmpdir(), 'codex-home-'))
  const sessionsDir = path.join(codexHome, 'sessions', 'p')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5-codex"\nservice_tier = "fast"\n', 'utf8')
  const sessionPath = path.join(sessionsDir, 'session.jsonl')
  await writeFile(sessionPath, SAMPLE_CODEX_SESSION, 'utf8')

  const events = await createCodexAdapter().parseSessionFile!(sessionPath, { _: [] })
  const usage = events.filter(event => event.type === 'model.usage')
  assert.ok(usage.length > 0, 'expected at least one model.usage')
  for (const event of usage) {
    assert.equal(event.model, 'gpt-5-codex')
  }
})

test('codex parser appends -fast when turn_context carries service_tier="fast"', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'codex-home-'))
  const sessionsDir = path.join(codexHome, 'sessions', 'p')
  await mkdir(sessionsDir, { recursive: true })
  const sessionPath = path.join(sessionsDir, 'session.jsonl')
  await writeFile(sessionPath, [
    JSON.stringify({ timestamp: '2026-05-13T09:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5-codex', service_tier: 'fast' } }),
    JSON.stringify({
      timestamp: '2026-05-13T09:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model: 'gpt-5-codex',
          last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 150 },
          total_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 150 },
        },
      },
    }),
  ].join('\n'), 'utf8')

  const events = await createCodexAdapter().parseSessionFile!(sessionPath, { _: [] })
  const usage = events.filter(event => event.type === 'model.usage')
  assert.ok(usage.length > 0)
  for (const event of usage) {
    assert.equal(event.model, 'gpt-5-codex-fast')
  }
})

test('codex parser maps per-turn service_tier="priority" to the -fast model variant', async () => {
  // Codex's "priority" is the second flavor of fast inference; ccusage maps
  // both to its single "fast" speed bucket. Backend pricing keys on model only.
  const codexHome = await mkdtemp(path.join(tmpdir(), 'codex-home-'))
  const sessionsDir = path.join(codexHome, 'sessions', 'p')
  await mkdir(sessionsDir, { recursive: true })
  const sessionPath = path.join(sessionsDir, 'session.jsonl')
  await writeFile(sessionPath, [
    JSON.stringify({ timestamp: '2026-05-13T09:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5-codex', service_tier: 'priority' } }),
    JSON.stringify({
      timestamp: '2026-05-13T09:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model: 'gpt-5-codex',
          last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 150 },
          total_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 150 },
        },
      },
    }),
  ].join('\n'), 'utf8')

  const events = await createCodexAdapter().parseSessionFile!(sessionPath, { _: [] })
  const usage = events.filter(event => event.type === 'model.usage')
  assert.ok(usage.length > 0)
  for (const event of usage) {
    assert.equal(event.model, 'gpt-5-codex-fast')
  }
})

test('codex parser ignores config.toml fast when the turn explicitly says default', async () => {
  // Mixed scenario: user has fast on now (config.toml), but an old turn
  // explicitly recorded service_tier="default". The turn wins — no -fast.
  const codexHome = await mkdtemp(path.join(tmpdir(), 'codex-home-'))
  const sessionsDir = path.join(codexHome, 'sessions', 'p')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(path.join(codexHome, 'config.toml'), 'service_tier = "fast"\n', 'utf8')
  const sessionPath = path.join(sessionsDir, 'session.jsonl')
  await writeFile(sessionPath, [
    JSON.stringify({ timestamp: '2026-05-13T09:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5-codex', service_tier: 'default' } }),
    JSON.stringify({
      timestamp: '2026-05-13T09:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model: 'gpt-5-codex',
          last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 150 },
          total_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5, total_tokens: 150 },
        },
      },
    }),
  ].join('\n'), 'utf8')

  const events = await createCodexAdapter().parseSessionFile!(sessionPath, { _: [] })
  const usage = events.filter(event => event.type === 'model.usage')
  assert.ok(usage.length > 0)
  for (const event of usage) {
    assert.equal(event.model, 'gpt-5-codex')
  }
})

test('codex parser keeps bare model name when neither config.toml nor session evidence is present', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'codex-home-'))
  const sessionsDir = path.join(codexHome, 'sessions', 'p')
  await mkdir(sessionsDir, { recursive: true })
  const sessionPath = path.join(sessionsDir, 'session.jsonl')
  await writeFile(sessionPath, SAMPLE_CODEX_SESSION, 'utf8')

  const events = await createCodexAdapter().parseSessionFile!(sessionPath, { _: [] })
  const usage = events.filter(event => event.type === 'model.usage')
  for (const event of usage) {
    assert.equal(event.model, 'gpt-5-codex')
  }
})

test('AMP_DATA_DIR relocates Amp detect and source paths', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const ampDir = await mkdtemp(path.join(tmpdir(), 'amp-data-'))

  const targets = await detectTargets(home, { AMP_DATA_DIR: ampDir })
  assert.equal(targets.amp.detectPath, ampDir)
  assert.equal(targets.amp.installedPath, path.join(ampDir, 'threads'))

  // Amp has no plugin/hook surface, so install is a no-op but must succeed.
  const exitCode = await run(['install', '--target', 'amp', '--home', home], testContext({
    env: { HOME: home, AMP_DATA_DIR: ampDir },
  }))
  assert.equal(exitCode, 0)
})

test('backfill plan parses Amp thread JSON into model.usage events with cache tokens', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const ampDir = await mkdtemp(path.join(tmpdir(), 'amp-data-'))
  const threadsDir = path.join(ampDir, 'threads')
  await mkdir(threadsDir, { recursive: true })

  const thread = {
    id: 'T_abc',
    messages: [
      { role: 'user', messageId: 0 },
      {
        role: 'assistant',
        messageId: 1,
        usage: { cacheCreationInputTokens: 200, cacheReadInputTokens: 50 },
      },
    ],
    usageLedger: {
      events: [
        {
          timestamp: '2026-05-18T10:00:00.000Z',
          model: 'anthropic/claude-sonnet-4-5',
          credits: 12.5,
          tokens: { input: 1000, output: 300 },
          operationType: 'inference',
          fromMessageId: 0,
          toMessageId: 1,
        },
      ],
    },
  }
  await writeFile(path.join(threadsDir, 'thread_abc.json'), JSON.stringify(thread), 'utf8')

  let output = ''
  const exitCode = await run([
    'backfill',
    'plan',
    '--source',
    'amp',
    '--home',
    home,
    '--json',
    '--include-source-path',
  ], testContext({
    env: { HOME: home, AMP_DATA_DIR: ampDir },
    stdout: { write: (text: string) => {
      output += text
    } },
  }))
  assert.equal(exitCode, 0)
  const plan = JSON.parse(output)
  const ampCandidate = plan.candidates.find((c: { source: string }) => c.source === 'amp')
  assert.ok(ampCandidate, 'expected an amp backfill candidate')
  assert.equal(ampCandidate.path, threadsDir)
  assert.equal(ampCandidate.exists, true)
  assert.equal(ampCandidate.entries, 1)

  const ampPlanned = plan.plannedEvents.filter((e: { source: string }) => e.source === 'amp')
  const modelUsage = ampPlanned.filter((e: { type: string }) => e.type === 'model.usage')
  assert.equal(modelUsage.length, 1, `expected one model.usage from Amp thread, got: ${JSON.stringify(ampPlanned)}`)
  assert.equal(ampPlanned.some((e: { type: string }) => e.type === 'session.started'), true)
  assert.equal(ampPlanned.some((e: { type: string }) => e.type === 'session.ended'), true)
})

test('XDG_DATA_HOME relocates OpenCode backfill source candidates', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const xdgData = await mkdtemp(path.join(tmpdir(), 'xdg-data-'))

  let output = ''
  const exitCode = await run([
    'backfill',
    'plan',
    '--source',
    'opencode',
    '--home',
    home,
    '--json',
    '--include-source-path',
  ], testContext({
    env: { HOME: home, XDG_DATA_HOME: xdgData },
    stdout: { write: (text: string) => {
      output += text
    } },
  }))
  assert.equal(exitCode, 0)
  const plan = JSON.parse(output)
  const candidatePaths = plan.candidates
    .filter((c: { source: string }) => c.source === 'opencode')
    .map((c: { path: string }) => c.path)
  assert.ok(
    candidatePaths.includes(path.join(xdgData, 'opencode', 'opencode.db')),
    `expected XDG_DATA_HOME path among ${JSON.stringify(candidatePaths)}`,
  )
})

// Mock the device-code endpoints: /start hands back a fixed code pair,
// /poll replays the supplied statuses in order (repeating the last).
function linkFetch(pollStatuses: Array<Record<string, unknown>>) {
  const requests: Array<{ url: string, body: string }> = []
  let pollIdx = 0
  const impl = (async (url: string, init?: { body?: string }) => {
    const u = String(url)
    requests.push({ url: u, body: typeof init?.body === 'string' ? init.body : '' })
    if (u.endsWith('/v3/agent/cli/link/start')) {
      return Response.json({
        deviceCode: 'device-secret-1',
        userCode: 'WXYZ2345',
        verificationUri: 'https://codetime.dev/cli/auth',
        verificationUriComplete: 'https://codetime.dev/cli/auth?code=WXYZ2345',
        interval: 1,
        expiresIn: 600,
      })
    }
    if (u.endsWith('/v3/agent/cli/link/poll')) {
      const status = pollStatuses[Math.min(pollIdx, pollStatuses.length - 1)]
      pollIdx += 1
      return Response.json(status)
    }
    throw new Error(`unexpected url ${u}`)
  }) as unknown as RunContext['fetch']
  return { impl, requests }
}

test('login polls the device-code endpoint and saves the approved token', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  let output = ''
  const { impl, requests } = linkFetch([{ status: 'approved', token: 'upload_abc123', userId: 7 }])

  const exitCode = await run(['login', '--no-browser', '--home', home], testContext({
    env: { HOME: home },
    fetch: impl,
    stdout: { write: (text: string) => {
      output += text
    } },
  }))

  assert.equal(exitCode, 0)
  // The printed URL + code let an SSH user open it on another device.
  assert.match(output, /\/cli\/auth\?code=WXYZ2345/)
  assert.match(output, /WXYZ2345/)
  // start is POSTed before any poll.
  assert.ok(requests[0].url.endsWith('/v3/agent/cli/link/start'))
  assert.ok(requests.some(r => r.url.endsWith('/v3/agent/cli/link/poll') && r.body.includes('device-secret-1')))

  const config = JSON.parse(await readFile(path.join(home, '.codetime', 'config.json'), 'utf8'))
  assert.equal(config.token, 'upload_abc123')
  assert.equal(config.userId, '7')
})

test('login keeps polling while pending, then saves on approval', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const { impl } = linkFetch([
    { status: 'pending' },
    { status: 'approved', token: 'tok_2', userId: 9 },
  ])

  const exitCode = await run(['login', '--no-browser', '--home', home], testContext({
    env: { HOME: home },
    fetch: impl,
    stdout: { write: () => {} },
  }))

  assert.equal(exitCode, 0)
  const config = JSON.parse(await readFile(path.join(home, '.codetime', 'config.json'), 'utf8'))
  assert.equal(config.token, 'tok_2')
})

test('login fails and writes no token when the code expires', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'codetime-'))
  const { impl } = linkFetch([{ status: 'expired' }])

  const exitCode = await run(['login', '--no-browser', '--home', home], testContext({
    env: { HOME: home },
    fetch: impl,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  }))

  assert.equal(exitCode, 1)
  await assert.rejects(readFile(path.join(home, '.codetime', 'config.json'), 'utf8'), { code: 'ENOENT' })
})

test('sync uploads local history via the import path', async () => {
  const home = await createCodexBackfillHome()
  const calls: Array<{ url: string, body: string }> = []

  // `sync` is sugar for `backfill import --source all`; with codex
  // fixtures present it must POST rollups to the ingest endpoint.
  const exitCode = await run(['sync', '--home', home, '--api-url', 'http://example.test'], testContext({
    stdout: { write: () => {} },
    fetch: async (url, init) => {
      const body = String(init?.body)
      const rollups = JSON.parse(body).rollups
      calls.push({ url: String(url), body })
      return Response.json({ inserted: rollups.length, skipped: 0, conflicts: 0, conflictIds: [] }, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v3\/agent\/ingest$/)
})

test('sync --dry-run plans without uploading', async () => {
  const home = await createCodexBackfillHome()
  const calls: string[] = []

  const exitCode = await run(['sync', '--dry-run', '--home', home, '--api-url', 'http://example.test'], testContext({
    stdout: { write: () => {} },
    fetch: async (url) => {
      calls.push(String(url))
      return Response.json({}, { status: 200 })
    },
  }))

  assert.equal(exitCode, 0)
  assert.equal(calls.length, 0)
})
