import type { BackfillSourceId } from '@codetime/shared'
import type { AgentAdapter } from './types.js'

export class AdapterRegistry {
  private adapters = new Map<BackfillSourceId, AgentAdapter>()

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(id: BackfillSourceId | string): AgentAdapter | undefined {
    return this.adapters.get(normalizeId(id))
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()]
  }

  /** Returns adapters that have a backfill parser */
  backfillable(): AgentAdapter[] {
    return this.all().filter(a => typeof a.parseSessionFile === 'function')
  }

  getParser(
    id: BackfillSourceId | string,
  ): ((filePath: string, options: Record<string, unknown> & { _: string[] }) => Promise<
    import('@codetime/shared').CanonicalEvent[]
  >) | undefined {
    return this.get(id)?.parseSessionFile
  }
}

function normalizeId(id: string): BackfillSourceId {
  if (id === 'claude') {
    return 'claude-code' as BackfillSourceId
  }
  return id as BackfillSourceId
}
