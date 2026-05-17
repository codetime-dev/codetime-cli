import type { FileActivityRecord } from '@codetime/shared'
import { isPlainObject, stringField } from './fields.js'

export function parseApplyPatch(patch: string, ts: string): FileActivityRecord[] {
  const changes: FileActivityRecord[] = []
  let current: FileActivityRecord | undefined

  for (const line of patch.split('\n')) {
    const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (fileMatch) {
      current = {
        ts,
        path: fileMatch[2].trim(),
        operation: fileMatch[1] === 'Add' ? 'create' : fileMatch[1] === 'Delete' ? 'delete' : 'edit',
        linesAdded: 0,
        linesRemoved: 0,
      }
      changes.push(current)
      continue
    }

    if (!current) {
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.linesAdded = (current.linesAdded || 0) + 1
    }
    else if (line.startsWith('-') && !line.startsWith('---')) {
      current.linesRemoved = (current.linesRemoved || 0) + 1
    }
  }

  return changes
}

export function patchFromCommand(command: string | undefined): string | undefined {
  if (!command || !command.includes('*** Begin Patch')) {
    return undefined
  }
  return command.slice(command.indexOf('*** Begin Patch'))
}

export function diffStats(diff: string): { linesAdded?: number, linesRemoved?: number } {
  let linesAdded = 0
  let linesRemoved = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded += 1
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved += 1
    }
  }

  return {
    linesAdded: linesAdded || undefined,
    linesRemoved: linesRemoved || undefined,
  }
}

export function patchChangeOperation(type: string | undefined): FileActivityRecord['operation'] {
  if (type === 'add') {
    return 'create'
  }
  if (type === 'delete') {
    return 'delete'
  }
  return 'edit'
}

export function fileActivitiesFromPatchChanges(
  changes: Record<string, unknown>,
  ts: string,
  cwd: string | undefined,
  displayFilePath: (filePath: string, cwd: string | undefined) => string,
): FileActivityRecord[] {
  return Object.entries(changes).map(([filePath, change]) => {
    const changeObject = isPlainObject(change) ? change : {}
    const operation = patchChangeOperation(stringField(changeObject, 'type'))
    const diff = stringField(changeObject, 'unified_diff') || ''
    const stats = diffStats(diff)

    return {
      ts,
      path: displayFilePath(filePath, cwd),
      operation,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
      confidence: 'derived' as const,
    }
  })
}
