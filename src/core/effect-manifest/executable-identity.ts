import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

import type { EffectManifestV1 } from './types.js'

/** Gate-time upper bound for hashing executables during manifest identity checks. */
export const MAX_EXECUTABLE_IDENTITY_BYTES = 64 * 1024 * 1024

export interface ExecutableIdentityDependencies {
  /** Test seam invoked after reading from the opened descriptor and before pathname verification. */
  afterFileRead?: (canonicalPath: string) => void
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) {
      return false
    }
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function readStableFile(
  canonicalPath: string,
  dependencies: ExecutableIdentityDependencies = {},
): Buffer | null {
  let descriptor: number | null = null
  try {
    descriptor = openSync(canonicalPath, 'r')
    const before = fstatSync(descriptor)
    if (!before.isFile()) {
      return null
    }
    if (before.size > MAX_EXECUTABLE_IDENTITY_BYTES) {
      return null
    }
    const content = readFileSync(descriptor)
    dependencies.afterFileRead?.(canonicalPath)
    const after = fstatSync(descriptor)
    const pathAfter = statSync(canonicalPath)
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.ino !== pathAfter.ino ||
      after.dev !== pathAfter.dev ||
      realpathSync(canonicalPath) !== canonicalPath
    ) {
      return null
    }
    return content
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor)
    }
  }
}

function hashFileAtCanonicalPath(
  canonicalPath: string,
  dependencies: ExecutableIdentityDependencies = {},
): string | null {
  const content = readStableFile(canonicalPath, dependencies)
  return content ? createHash('sha256').update(content).digest('hex') : null
}

function executableCandidates(head: string, cwd: string, pathEnv: string): string[] {
  if (head.includes('/') || head.startsWith('.')) {
    return [path.resolve(cwd, head)]
  }
  return pathEnv
    .split(path.delimiter)
    .map((entry) => path.join(entry.length > 0 ? path.resolve(cwd, entry) : cwd, head))
}

function resolveExecutablePath(head: string, cwd: string, pathEnv: string): string | null {
  for (const candidate of executableCandidates(head, cwd, pathEnv)) {
    if (!isExecutableFile(candidate)) {
      continue
    }
    try {
      return realpathSync(candidate)
    } catch {}
  }
  return null
}

function resolveScriptInterpreter(
  content: Buffer,
  cwd: string,
  pathEnv: string,
  dependencies: ExecutableIdentityDependencies = {},
): { canonicalPath: string; sha256: string } | { error: string } | null {
  if (content.length < 2 || content[0] !== 0x23 || content[1] !== 0x21) {
    return null
  }
  const firstLine = content
    .subarray(2, Math.min(content.length, 4096))
    .toString('utf8')
    .split(/\r?\n/, 1)[0]
  if (firstLine === undefined || firstLine.trim() !== firstLine || firstLine.length === 0) {
    return { error: 'unsupported_script_interpreter' }
  }
  const parts = firstLine.split(/[ \t]+/)
  let interpreterPath: string | null = null
  if (parts.length === 1 && parts[0]?.startsWith('/')) {
    interpreterPath = resolveExecutablePath(parts[0], cwd, pathEnv)
  } else if (
    parts.length === 2 &&
    parts[0] === '/usr/bin/env' &&
    parts[1] !== undefined &&
    !parts[1].includes('/')
  ) {
    interpreterPath = resolveExecutablePath(parts[1], cwd, pathEnv)
  } else {
    return { error: 'unsupported_script_interpreter' }
  }
  if (!interpreterPath) {
    return { error: 'script_interpreter_not_found' }
  }
  const sha256 = hashFileAtCanonicalPath(interpreterPath, dependencies)
  if (!sha256) {
    return { error: 'script_interpreter_unreadable' }
  }
  return { canonicalPath: interpreterPath, sha256 }
}

export function verifyStoredExecutableIdentity(
  command: EffectManifestV1['command'],
  dependencies: ExecutableIdentityDependencies = {},
): 'ok' | 'missing' | 'changed' | 'not_regular' | 'not_executable' {
  try {
    if (!existsSync(command.canonicalPath)) {
      return 'missing'
    }
    const stat = statSync(command.canonicalPath)
    if (!stat.isFile()) {
      return 'not_regular'
    }
    if (!isExecutableFile(command.canonicalPath)) {
      return 'not_executable'
    }
    const canonicalPath = realpathSync(command.canonicalPath)
    if (canonicalPath !== command.canonicalPath) {
      return 'changed'
    }
    const digest = hashFileAtCanonicalPath(canonicalPath, dependencies)
    if (!digest || digest !== command.sha256) {
      return 'changed'
    }
    if (command.interpreter) {
      if (!existsSync(command.interpreter.canonicalPath)) {
        return 'missing'
      }
      const interpreterStat = statSync(command.interpreter.canonicalPath)
      if (!interpreterStat.isFile()) {
        return 'not_regular'
      }
      if (!isExecutableFile(command.interpreter.canonicalPath)) {
        return 'not_executable'
      }
      const interpreterCanonical = realpathSync(command.interpreter.canonicalPath)
      if (interpreterCanonical !== command.interpreter.canonicalPath) {
        return 'changed'
      }
      const interpreterDigest = hashFileAtCanonicalPath(interpreterCanonical, dependencies)
      if (!interpreterDigest || interpreterDigest !== command.interpreter.sha256) {
        return 'changed'
      }
    }
    return 'ok'
  } catch {
    return 'changed'
  }
}

export type ResolvedExecutableCommand = EffectManifestV1['command']

export function resolveNativeExecutableIdentity(
  head: string,
  cwd: string,
  pathEnv: string,
  dependencies: ExecutableIdentityDependencies = {},
): ResolvedExecutableCommand | { error: string } {
  const basename = path.basename(head)
  const candidates = executableCandidates(head, cwd, pathEnv)
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !isExecutableFile(candidate)) {
        continue
      }
      const stat = statSync(candidate)
      if (!stat.isFile()) {
        continue
      }
      if (stat.size > MAX_EXECUTABLE_IDENTITY_BYTES) {
        return { error: 'executable_too_large' }
      }
      const canonicalPath = realpathSync(candidate)
      if (statSync(canonicalPath).size > MAX_EXECUTABLE_IDENTITY_BYTES) {
        return { error: 'executable_too_large' }
      }
      const content = readStableFile(canonicalPath, dependencies)
      if (!content) {
        return { error: 'executable_changed_during_read' }
      }
      const sha256 = createHash('sha256').update(content).digest('hex')
      const interpreter = resolveScriptInterpreter(content, cwd, pathEnv, dependencies)
      if (interpreter && 'error' in interpreter) {
        return interpreter
      }
      return {
        basename,
        canonicalPath,
        sha256,
        kind: interpreter ? 'script' : 'native',
        ...(interpreter ? { interpreter } : {}),
      }
    } catch {}
  }
  return { error: 'executable_not_found' }
}
