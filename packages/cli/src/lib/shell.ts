import type { FileActivityRecord } from '@codetime/shared'
import path from 'node:path'

export function fileActivitiesFromShellCommand(
  command: string,
  ts: string,
  rootCwd: string | undefined,
  initialCwd: string | undefined,
): FileActivityRecord[] {
  const activities: FileActivityRecord[] = []
  let currentCwd = initialCwd

  for (const segment of command.split(/\s*(?:&&|\|\||\||;)\s*/)) {
    const words = shellWords(segment)
    if (words.length === 0) {
      continue
    }
    const commandName = path.basename(words[0])
    if (commandName === 'cd' && words[1]) {
      currentCwd = resolvePath(words[1], currentCwd)
      continue
    }

    for (const item of shellReadTargets(words, currentCwd)) {
      activities.push({
        ts,
        path: displayActivityPath(item.path, rootCwd, currentCwd),
        operation: item.operation,
        confidence: 'derived',
      })
    }
  }

  return activities
}

function shellReadTargets(
  words: string[],
  cwd: string | undefined,
): Array<{ path: string, operation: FileActivityRecord['operation'] }> {
  const command = path.basename(words[0]).toLowerCase()
  if (['cat', 'less', 'more', 'nl'].includes(command)) {
    return fileArgs(words.slice(1), new Set()).map(item => ({ path: item, operation: 'read' as const }))
  }
  if (command === 'sed') {
    const args = commandArgs(words.slice(1), new Set(['-e', '--expression', '-f', '--file']))
    return args.slice(1).filter(looksLikePathArg).map(item => ({ path: item, operation: 'read' as const }))
  }
  if (command === 'head' || command === 'tail') {
    return fileArgs(words.slice(1), new Set(['-n', '-c', '--lines', '--bytes'])).map(item => ({ path: item, operation: 'read' as const }))
  }
  if (['rg', 'grep', 'ag'].includes(command)) {
    const hasPatternOption = words.includes('-e') || words.includes('--regexp') || words.includes('-f') || words.includes('--file')
    const args = commandArgs(words.slice(1), new Set(['-e', '--regexp', '-f', '--file', '-g', '--glob', '-t', '-T', '-A', '-B', '-C', '-m']))
    const pathArgs = hasPatternOption ? args : args.slice(1)
    return pathArgs.filter(looksLikePathArg).map(item => ({ path: item, operation: 'search' as const }))
  }
  if (command === 'find') {
    const args = fileArgs(words.slice(1), new Set())
    return args.slice(0, 1).map(item => ({ path: item, operation: 'search' as const }))
  }
  if (command === 'pwd' && cwd) {
    return [{ path: cwd, operation: 'search' }]
  }
  return []
}

function fileArgs(args: string[], optionsWithValues: Set<string>): string[] {
  return commandArgs(args, optionsWithValues).filter(looksLikePathArg)
}

function commandArgs(args: string[], optionsWithValues: Set<string>): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg || arg === '--') {
      continue
    }
    if (arg.startsWith('-')) {
      if (optionsWithValues.has(arg)) {
        index += 1
      }
      continue
    }
    result.push(arg)
  }
  return result
}

function looksLikePathArg(value: string): boolean {
  if (!value || value.startsWith('$')) {
    return false
  }
  if (['>', '>>', '<', '2>', '2>>'].includes(value)) {
    return false
  }
  return path.isAbsolute(value) || value.includes('/') || value.includes('.')
}

export function shellWords(command: string): string[] {
  const matches = command.match(/"([^"\\]|\\.)*"|'[^']*'|\S+/g) || []
  return matches.map((word) => {
    if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith('\'') && word.endsWith('\''))) {
      return word.slice(1, -1)
    }
    return word
  })
}

export function resolvePath(filePath: string, cwd: string | undefined): string {
  if (path.isAbsolute(filePath) || !cwd) {
    return filePath
  }
  return path.resolve(cwd, filePath)
}

export function displayFilePath(filePath: string, cwd: string | undefined): string {
  if (!cwd || !path.isAbsolute(filePath)) {
    return filePath
  }
  const relative = path.relative(cwd, filePath)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath
}

export function displayActivityPath(
  filePath: string,
  rootCwd: string | undefined,
  currentCwd: string | undefined,
): string {
  if (path.isAbsolute(filePath)) {
    return displayFilePath(filePath, rootCwd)
  }
  if (currentCwd && path.isAbsolute(currentCwd)) {
    return displayFilePath(path.resolve(currentCwd, filePath), rootCwd)
  }
  return filePath
}
