import path from 'node:path'
import { createStableHash } from '@codetime/shared'
import { isPlainObject } from './fields.js'

/** A turn whose latest event is older than this window is considered idle. */
export const TURN_IDLE_MS = 60_000

export function isTurnIdle(lastEventAt: string | undefined): boolean {
  if (!lastEventAt) {
    return false
  }
  const lastMs = Date.parse(lastEventAt)
  if (!Number.isFinite(lastMs)) {
    return false
  }
  return Date.now() - lastMs > TURN_IDLE_MS
}

export function sessionIdFromFilePath(filePath: string, prefix: string): string {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})/)
  return match?.[1] || `${prefix}_${createStableHash(filePath).slice(0, 24)}`
}

export function hookHandler(agentId: string, statusMessage: string) {
  return {
    type: 'command',
    command: `codetime hook --agent ${agentId}`,
    timeout: 10,
    statusMessage,
  }
}

export async function isHooksJsonInstalled(filePath: string, command: string): Promise<boolean> {
  try {
    const { readTextIfExists } = await import('./fs.js')
    const text = await readTextIfExists(filePath)
    if (!text) {
      return false
    }
    const config = JSON.parse(text)
    if (!isPlainObject(config) || !isPlainObject(config.hooks)) {
      return false
    }
    return Object.values(config.hooks).some(groups =>
      Array.isArray(groups) && groups.some(group =>
        isPlainObject(group) && Array.isArray(group.hooks)
        && group.hooks.some((hook: Record<string, unknown>) => hook.command === command),
      ),
    )
  }
  catch {
    return false
  }
}
