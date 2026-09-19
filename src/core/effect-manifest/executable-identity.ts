import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import type { EffectManifestV1 } from './types.js'

function hashFileAtCanonicalPath(canonicalPath: string): string | null {
  try {
    const before = statSync(canonicalPath)
    if (!before.isFile()) {
      return null
    }
    const content = readFileSync(canonicalPath)
    const after = statSync(canonicalPath)
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      return null
    }
    return createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}

export function verifyStoredExecutableIdentity(
  command: EffectManifestV1['command'],
): 'ok' | 'missing' | 'changed' | 'not_regular' {
  try {
    if (!existsSync(command.canonicalPath)) {
      return 'missing'
    }
    const stat = statSync(command.canonicalPath)
    if (!stat.isFile()) {
      return 'not_regular'
    }
    const canonicalPath = realpathSync(command.canonicalPath)
    if (canonicalPath !== command.canonicalPath) {
      return 'changed'
    }
    const digest = hashFileAtCanonicalPath(canonicalPath)
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
      const interpreterCanonical = realpathSync(command.interpreter.canonicalPath)
      const interpreterDigest = hashFileAtCanonicalPath(interpreterCanonical)
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
): ResolvedExecutableCommand | { error: string } {
  const basename = path.basename(head)
  const candidates: string[] = []
  if (head.includes('/') || head.startsWith('.')) {
    candidates.push(path.resolve(cwd, head))
  } else {
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!dir) {
        continue
      }
      candidates.push(path.join(dir, head))
    }
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) {
        continue
      }
      const stat = statSync(candidate)
      if (!stat.isFile()) {
        continue
      }
      const canonicalPath = realpathSync(candidate)
      const before = statSync(canonicalPath)
      const content = readFileSync(canonicalPath)
      const after = statSync(canonicalPath)
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        return { error: 'executable_changed_during_read' }
      }
      const sha256 = createHash('sha256').update(content).digest('hex')
      return {
        basename,
        canonicalPath,
        sha256,
        kind: 'native',
      }
    } catch {
      continue
    }
  }
  return { error: 'executable_not_found' }
}
