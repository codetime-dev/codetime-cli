import type { FileActivityRecord, TelemetryEventType } from '@codetime/shared'
import path from 'node:path'
import { displayFilePath } from './shell.js'

export function operationForTool(tool: string | undefined): FileActivityRecord['operation'] {
  const normalized = (tool || '').toLowerCase()
  if (['read', 'notebookread', 'view_image'].includes(normalized)) {
    return 'read'
  }
  if (['grep', 'glob', 'ls', 'search', 'rg'].includes(normalized)) {
    return 'search'
  }
  if (['write'].includes(normalized)) {
    return 'write'
  }
  if (['edit', 'multiedit', 'notebookedit', 'apply_patch', 'applypatch'].includes(normalized)) {
    return 'edit'
  }
  return 'read'
}

export function toolFileActivityType(tool: string): TelemetryEventType {
  const readTools = ['read', 'glob', 'grep', 'webfetch', 'websearch']
  if (readTools.includes(tool.toLowerCase())) {
    return 'file.read'
  }
  return 'file.changed'
}

export function selectFileOperation(
  current: FileActivityRecord['operation'] | undefined,
  next: FileActivityRecord['operation'],
): FileActivityRecord['operation'] {
  if (!current) {
    return next
  }
  if (isWriteOperation(current) && !isWriteOperation(next)) {
    return current
  }
  return next
}

export function isWriteOperation(operation: FileActivityRecord['operation']): boolean {
  return operation === 'create' || operation === 'write' || operation === 'edit' || operation === 'delete'
}

export function eventTypeFromFileActivities(files: FileActivityRecord[]): TelemetryEventType {
  if (files.some(file => isWriteOperation(file.operation))) {
    return 'file.changed'
  }
  if (files.some(file => file.operation === 'search')) {
    return 'file.searched'
  }
  return 'file.read'
}

export function mergeFileActivity(
  current: FileActivityRecord | undefined,
  next: FileActivityRecord,
): FileActivityRecord {
  return {
    ts: next.ts,
    path: next.path,
    operation: selectFileOperation(current?.operation, next.operation),
    bytesRead: sumOptional(current?.bytesRead, next.bytesRead),
    bytesWritten: sumOptional(current?.bytesWritten, next.bytesWritten),
    charsRead: sumOptional(current?.charsRead, next.charsRead),
    charsWritten: sumOptional(current?.charsWritten, next.charsWritten),
    linesRead: sumOptional(current?.linesRead, next.linesRead),
    linesAdded: (current?.linesAdded || 0) + (next.linesAdded || 0),
    linesRemoved: (current?.linesRemoved || 0) + (next.linesRemoved || 0),
  }
}

export function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  const sum = (left || 0) + (right || 0)
  return sum || undefined
}

export function summarizeFileActivities(files: FileActivityRecord[]): {
  linesAdded?: number
  linesRemoved?: number
} {
  const linesAdded = files.reduce((total, file) => total + (file.linesAdded || 0), 0)
  const linesRemoved = files.reduce((total, file) => total + (file.linesRemoved || 0), 0)
  return {
    linesAdded: linesAdded || undefined,
    linesRemoved: linesRemoved || undefined,
  }
}

export function addPathActivity(
  changes: Map<string, FileActivityRecord>,
  filePath: string | undefined,
  operation: FileActivityRecord['operation'],
  ts: string,
): void {
  if (!filePath) {
    return
  }
  const current = changes.get(filePath)
  changes.set(filePath, mergeFileActivity(current, { ts, path: filePath, operation }))
}

export function addResolvedPathActivity(
  changes: Map<string, FileActivityRecord>,
  filePath: string | undefined,
  operation: FileActivityRecord['operation'],
  ts: string,
  rootCwd: string | undefined,
  currentCwd: string | undefined,
  metrics: Partial<FileActivityRecord> = {},
): void {
  if (!filePath) {
    return
  }
  const resolvedPath = path.isAbsolute(filePath)
    ? displayFilePath(filePath, rootCwd)
    : currentCwd && path.isAbsolute(currentCwd)
      ? displayFilePath(path.resolve(currentCwd, filePath), rootCwd)
      : filePath
  changes.set(
    resolvedPath,
    mergeFileActivity(changes.get(resolvedPath), { ts, path: resolvedPath, operation, ...metrics }),
  )
}

export function displayBackfillPath(filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath
  }
  return path.basename(filePath)
}

export function countTextLines(text: string | undefined): number | undefined {
  if (!text) {
    return undefined
  }
  return text.split(/\r\n|\r|\n/).length
}
