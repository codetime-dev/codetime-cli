import type { InstallEntry } from '../adapters/types.js'
import { isPlainObject } from '../lib/fields.js'
import { writeGeneratedFile } from '../lib/fs.js'

export { GENERATED_MARKER } from '../lib/constants.js'

export async function installEntry(
  entry: InstallEntry,
  options: {
    dryRun: boolean
    force: boolean
    onWrite: (message: string) => void
  },
): Promise<void> {
  if (entry.kind === 'hooks-json' && typeof entry.content === 'object') {
    await mergeHooksJson(entry.path, entry.content, options)
    return
  }

  await writeGeneratedFile(entry.path, String(entry.content), {
    ...options,
    onWrite: options.onWrite,
  })
}

async function mergeHooksJson(
  filePath: string,
  content: object,
  { dryRun, force, onWrite }: {
    dryRun: boolean
    force: boolean
    onWrite: (message: string) => void
  },
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  // eslint-disable-next-line unicorn/import-style
  const pathMod = await import('node:path')

  if (dryRun) {
    onWrite(`Would merge ${filePath}`)
    return
  }

  const { readTextIfExists } = await import('../lib/fs.js')
  const existingText = await readTextIfExists(filePath)
  const existing = existingText ? JSON.parse(existingText) : {}
  if (existingText !== null && !isPlainObject(existing) && !force) {
    throw new Error(
      `Refusing to update non-object JSON file: ${filePath}. Re-run with --force if this is intentional.`,
    )
  }
  const merged = mergeHookObjects(existing, content)
  const nextText = `${JSON.stringify(merged, null, 2)}\n`

  if (existingText === nextText) {
    onWrite(`Already installed ${filePath}`)
    return
  }

  await mkdir(pathMod.dirname(filePath), { recursive: true })
  await writeFile(filePath, nextText, 'utf8')
  onWrite(`Installed ${filePath}`)
}

function mergeHookObjects(existing: unknown, addition: unknown): Record<string, unknown> {
  const merged = structuredClone(isPlainObject(existing) ? existing : {}) as Record<string, unknown>
  const additionObject = isPlainObject(addition) ? addition : {}
  const additionHooks = isPlainObject(additionObject.hooks) ? additionObject.hooks : {}
  merged.hooks = isPlainObject(merged.hooks) ? merged.hooks : {}
  const mergedHooks = merged.hooks as Record<string, unknown>

  for (const [event, groups] of Object.entries(additionHooks)) {
    if (!Array.isArray(groups)) {
      continue
    }
    const existingGroups = Array.isArray(mergedHooks[event]) ? mergedHooks[event] : []
    const nextGroups = [...existingGroups]

    for (const group of groups) {
      const command = hookCommandFromGroup(group)
      const alreadyPresent = existingGroups.some(
        existingGroup => hookCommandFromGroup(existingGroup) === command,
      )
      if (!alreadyPresent) {
        nextGroups.push(group)
      }
    }

    mergedHooks[event] = nextGroups
  }

  return merged
}

function hookCommandFromGroup(group: unknown): string | undefined {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
    return undefined
  }
  const hook = group.hooks[0]
  return isPlainObject(hook) && typeof hook.command === 'string' ? hook.command : undefined
}

export async function hasHookCommand(filePath: string, command: string): Promise<boolean> {
  const { readJsonIfExists } = await import('../lib/fs.js')
  const config = await readJsonIfExists(filePath)
  if (!isPlainObject(config) || !isPlainObject(config.hooks)) {
    return false
  }

  return Object.values(config.hooks).some((groups) => {
    return Array.isArray(groups) && groups.some((group) => {
      return isPlainObject(group)
        && Array.isArray(group.hooks)
        && group.hooks.some(hook => isPlainObject(hook) && hook.command === command)
    })
  })
}
