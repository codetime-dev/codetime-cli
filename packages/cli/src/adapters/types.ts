import type { BackfillSourceId, CanonicalEvent } from '@codetime/shared'
import type { ParsedArgs } from '../lib/types.js'

export interface InstallEntry {
  kind: 'hooks-json' | 'file'
  path: string
  content: string | object
}

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
  detectPath: (home: string) => string
  /** Path of the codetime integration file when installed */
  installedPath: (home: string) => string
  /** Whether codetime integration is already installed */
  isInstalled: (home: string) => Promise<boolean>
  /** Installation entries to write during `codetime install` */
  installEntries: (home: string) => InstallEntry[]

  // ── Backfill ──

  /** Directories/files containing historical session data */
  sourcePaths: (home: string) => string[]
  /** Parse a single session file into canonical events, or null if unsupported */
  parseSessionFile?: (
    filePath: string,
    options: ParsedArgs,
  ) => Promise<CanonicalEvent[]>
}
