import { isPlainObject } from './fields.js'

export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line)
    return isPlainObject(parsed) ? parsed : undefined
  }
  catch {
    return undefined
  }
}

export function timestampFrom(value: unknown): string | undefined {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return value
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  const millis = value > 10_000_000_000 ? value : value * 1000
  return new Date(millis).toISOString()
}

export function durationObjectToMs(duration: Record<string, unknown>): number | undefined {
  const secs = (duration.secs as number) || 0
  const nanos = (duration.nanos as number) || 0
  const durationMs = (secs * 1000) + Math.round(nanos / 1_000_000)
  return durationMs || undefined
}

export function durationMsBetween(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (!startedAt || !endedAt) {
    return undefined
  }
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined
  }
  return Math.max(0, end - start)
}

export function msToIso(ms: number): string {
  return new Date(ms).toISOString()
}
