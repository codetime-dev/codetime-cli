// Centralized HTTP layer for talking to the codetime API. All routes share
// a single resolver for base URL + auth header so per-command code does
// not recompute them.
import type { SessionRollup } from '@codetime/shared'
import { readConfig } from './config.js'
import { PACKAGE_VERSION } from './constants.js'

export interface RemoteOptions {
  baseUrl: string
  token?: string
  fetchImpl: typeof fetch
}

export interface RemoteResolveInput {
  apiUrl?: string
  token?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  homeOverride?: string
}

const DEFAULT_BASE_URL = 'https://codetime.dev'

export function resolveRemote(input: RemoteResolveInput = {}): RemoteOptions | null {
  const env = input.env ?? process.env
  const stored = readConfig(input.homeOverride)
  const baseUrl
    = input.apiUrl
      || env.CODETIME_API_URL
      || stored.remoteUrl
      || DEFAULT_BASE_URL
  const token
    = input.token
      || env.CODETIME_TOKEN
      || stored.token
  const fetchImpl = input.fetch ?? globalThis.fetch
  if (!fetchImpl) {
    return null
  }
  return { baseUrl, token, fetchImpl }
}

interface SendRollupResult {
  inserted: number
  skipped: number
  conflicts: number
  failed: number
}

function buildHeaders(token?: string, machine?: MachineHeaders): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': `codetime/${PACKAGE_VERSION}`,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    // Machine hints — read on the server when upserting the `machines`
    // row for a previously-unseen (userId, machineId) pair. Only the
    // id is strictly required; hostname/name/platform make the
    // dashboard entry meaningful on first appearance.
    ...(machine?.id ? { 'x-machine-id': machine.id } : {}),
    ...(machine?.hostname ? { 'x-machine-hostname': machine.hostname } : {}),
    ...(machine?.displayName ? { 'x-machine-name': machine.displayName } : {}),
    ...(machine?.platform ? { 'x-machine-platform': machine.platform } : {}),
  }
}

export interface MachineHeaders {
  id: string
  hostname?: string
  displayName?: string
  platform?: string
}

function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString()
}

export async function postRollupBatch(
  remote: RemoteOptions,
  rollups: SessionRollup[],
  options: { replace?: boolean, machine?: MachineHeaders } = {},
): Promise<SendRollupResult> {
  const response = await remote.fetchImpl(joinUrl(remote.baseUrl, '/v3/agent/ingest'), {
    method: 'POST',
    headers: buildHeaders(remote.token, options.machine),
    body: JSON.stringify({ rollups, replace: options.replace !== false }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`codetime API ${response.status}: ${body.slice(0, 4000)}`)
  }
  // codetime returns bare JSON. `failed` is no longer reported by the
  // server; keep the field for binary compatibility with old callers
  // and synthesise zero.
  const data = await response.json() as Partial<SendRollupResult>
  return {
    inserted: Number(data.inserted) || 0,
    skipped: Number(data.skipped) || 0,
    conflicts: Number(data.conflicts) || 0,
    failed: 0,
  }
}

// Purge all rollups for `source` that came from the current machine.
// Scope is intentionally per-machine — see the server route in
// server/routes/v3/agent/sessions/index.delete.ts for why.
export async function deleteRollupsBySource(
  remote: RemoteOptions,
  source: string,
  machine: MachineHeaders,
): Promise<number> {
  const response = await remote.fetchImpl(
    joinUrl(remote.baseUrl, `/v3/agent/sessions?source=${encodeURIComponent(source)}`),
    { method: 'DELETE', headers: buildHeaders(remote.token, machine) },
  )
  if (!response.ok) {
    throw new Error(`Failed to purge ${source}: ${response.status}`)
  }
  const body = await response.json() as { deleted?: number }
  return Number(body.deleted) || 0
}

// Device-link helpers (startCliLink/pollCliLink) were removed when the
// CLI moved to reusing the user's upload_token via `codetime token
// set <token>`. The server no longer exposes `/v3/agent/cli/link/*`.

export interface MachineRow {
  id: string
  hostname: string
  displayName: string
  platform?: string
  lastSeenAt?: string
  createdAt: string
}

export async function listMachines(remote: RemoteOptions): Promise<MachineRow[]> {
  const response = await remote.fetchImpl(joinUrl(remote.baseUrl, '/v3/machines'), {
    headers: buildHeaders(remote.token),
  })
  if (!response.ok) {
    throw new Error(`Failed to list machines: ${response.status}`)
  }
  const body = await response.json() as { machines: MachineRow[] }
  return body.machines
}

export async function renameMachine(
  remote: RemoteOptions,
  id: string,
  displayName: string,
): Promise<MachineRow> {
  const response = await remote.fetchImpl(joinUrl(remote.baseUrl, `/v3/machines/${id}`), {
    method: 'PATCH',
    headers: buildHeaders(remote.token),
    body: JSON.stringify({ displayName }),
  })
  if (!response.ok) {
    throw new Error(`Failed to rename machine: ${response.status}`)
  }
  return await response.json() as MachineRow
}

export async function deleteMachine(remote: RemoteOptions, id: string): Promise<{ deletedSessions: number }> {
  const response = await remote.fetchImpl(joinUrl(remote.baseUrl, `/v3/machines/${id}`), {
    method: 'DELETE',
    headers: buildHeaders(remote.token),
  })
  if (!response.ok) {
    throw new Error(`Failed to delete machine: ${response.status}`)
  }
  const body = await response.json() as { deletedSessions?: number }
  return { deletedSessions: Number(body.deletedSessions) || 0 }
}
