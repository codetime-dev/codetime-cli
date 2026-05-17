export function stringField(object: unknown, key: string): string | undefined {
  if (!isPlainObject(object)) {
    return undefined
  }
  const value = object[key]
  return typeof value === 'string' ? value : undefined
}

export function numberField(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function objectField(object: unknown, key: string): Record<string, unknown> {
  if (!isPlainObject(object) || !isPlainObject(object[key])) {
    return {}
  }
  return object[key] as Record<string, unknown>
}

export function arrayField(object: unknown, key: string): unknown[] {
  if (!isPlainObject(object) || !Array.isArray(object[key])) {
    return []
  }
  return object[key] as unknown[]
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function stringRefs(value: Record<string, string | undefined> | undefined): Record<string, string> {
  const refs: Record<string, string> = {}
  for (const [key, item] of Object.entries(value || {})) {
    if (typeof item === 'string' && item.length > 0) {
      refs[key] = item
    }
  }
  return refs
}

export function stringOption(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.at(-1)
  }
  return typeof value === 'string' ? value : undefined
}

export function valuesOption(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
  }
  return typeof value === 'string' ? [value] : []
}

export function fileOptions(value: unknown): string[] {
  return valuesOption(value).flatMap(item => item.split(',')).map(item => item.trim()).filter(Boolean)
}

export function numberOption(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return numberOption(value.at(-1))
  }
  const text = stringOption(value)
  if (!text) {
    return undefined
  }
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}
