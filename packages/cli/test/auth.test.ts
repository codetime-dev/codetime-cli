import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import {
  configPath,
  ensureLocalMachineId,
  machineIdPath,
  readConfig,
  writeConfig,
} from '../src/lib/config.ts'
import { resolveRemote } from '../src/lib/remote.ts'

async function tmpHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'codetime-cli-'))
}

test('config round-trip preserves token + machine id', async () => {
  const home = await tmpHome()
  assert.deepEqual(readConfig(home), {})
  writeConfig({
    remoteUrl: 'http://localhost:3002',
    token: 'upload_token_xyz',
    machineId: 'm-1',
    machineName: 'workstation',
    userId: 'u-1',
  }, home)
  const loaded = readConfig(home)
  assert.equal(loaded.token, 'upload_token_xyz')
  assert.equal(loaded.machineId, 'm-1')
  assert.equal(loaded.userId, 'u-1')
  // 0o600 — no group/other access.
  const info = await stat(configPath(home))
  assert.equal(info.mode & 0o077, 0)
})

test('ensurelocalmachineid is idempotent', async () => {
  const home = await tmpHome()
  const first = ensureLocalMachineId(home)
  const second = ensureLocalMachineId(home)
  assert.equal(first, second)
  const onDiskRaw = await readFile(machineIdPath(home), 'utf8')
  assert.equal(onDiskRaw.trim(), first)
})

test('resolveremote prefers explicit args > env > stored config', async () => {
  const home = await tmpHome()
  writeConfig({ remoteUrl: 'http://stored:1', token: 'stored-token' }, home)
  const fakeFetch = (async () => new Response()) as typeof fetch

  // Stored only.
  const stored = resolveRemote({ env: {}, fetch: fakeFetch, homeOverride: home })
  assert.equal(stored?.baseUrl, 'http://stored:1')
  assert.equal(stored?.token, 'stored-token')

  // Env overrides stored.
  const envOnly = resolveRemote({
    env: { CODETIME_API_URL: 'http://env:2', CODETIME_TOKEN: 'env-token' },
    fetch: fakeFetch,
    homeOverride: home,
  })
  assert.equal(envOnly?.baseUrl, 'http://env:2')
  assert.equal(envOnly?.token, 'env-token')

  // Explicit args win.
  const explicit = resolveRemote({
    apiUrl: 'http://arg:4',
    token: 'arg-token',
    env: { CODETIME_API_URL: 'http://env:2', CODETIME_AGENT_TOKEN: 'env-token' },
    fetch: fakeFetch,
    homeOverride: home,
  })
  assert.equal(explicit?.baseUrl, 'http://arg:4')
  assert.equal(explicit?.token, 'arg-token')
})
