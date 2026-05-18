import type { BackfillSourceId, CanonicalEvent } from '@codetime/shared'
import type { ParsedArgs } from '../lib/types.js'

export interface InstallEntry {
  kind: 'hooks-json' | 'file'
  path: string
  content: string | object
}

/**
 * Environment shape consumed by adapters when resolving paths. Adapters honor
 * the env vars exposed by each upstream agent so codetime tracks sessions
 * even when users relocate their config/data directories.
 */
export type AdapterEnv = Record<string, string | undefined>

export interface AgentAdapter {
  /** Unique identifier matching BackfillSourceId */
  readonly id: BackfillSourceId
  /** Human-readable label */
  readonly label: string
  /** Canonical agent name used in events */
  readonly agentName: string
  /** Category for detect display */
  readonly kind: 'agent' | 'ide'

  // ── Detection & Installation ──

  /** Path whose existence indicates the agent is installed */
  detectPath: (home: string, env?: AdapterEnv) => string
  /** Path of the codetime integration file when installed */
  installedPath: (home: string, env?: AdapterEnv) => string
  /** Whether codetime integration is already installed */
  isInstalled: (home: string, env?: AdapterEnv) => Promise<boolean>
  /** Installation entries to write during `codetime install` */
  installEntries: (home: string, env?: AdapterEnv) => InstallEntry[]

  // ── Backfill ──

  /** Directories/files containing historical session data */
  sourcePaths: (home: string, env?: AdapterEnv) => string[]
  /** Parse a single session file into canonical events, or null if unsupported */
  parseSessionFile?: (
    filePath: string,
    options: ParsedArgs,
  ) => Promise<CanonicalEvent[]>
}
