import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalStringify(child)}`).join(',')}}`
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function defaultControlPlaneDir(): string {
  if (process.platform === 'win32' && process.env.APPDATA?.trim()) {
    return path.join(process.env.APPDATA.trim(), 'agent-belay')
  }
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(process.env.HOME ?? '', '.config')
  return path.join(base, 'agent-belay')
}

function canonicalRepoRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot)
  } catch {
    return path.resolve(repoRoot)
  }
}

export function isTrustedCursorRoutingConfig(repoRoot: string, rawConfig: unknown): boolean {
  const canonicalRoot = canonicalRepoRoot(repoRoot)
  const identity = hashValue(`${canonicalRoot}\u0000cursor`)
  const recordPath = path.join(defaultControlPlaneDir(), 'config-trust', `${identity}.json`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(recordPath, 'utf8'))
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const record = parsed as Record<string, unknown>
  const expectedKeys = new Set([
    'schemaVersion',
    'repoRoot',
    'adapter',
    'repoConfigFingerprint',
    'trustedAt',
  ])
  if (
    Object.keys(record).length !== expectedKeys.size ||
    !Object.keys(record).every((key) => expectedKeys.has(key)) ||
    record.schemaVersion !== 1 ||
    record.adapter !== 'cursor' ||
    typeof record.repoRoot !== 'string' ||
    canonicalRepoRoot(record.repoRoot) !== canonicalRoot ||
    typeof record.repoConfigFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.repoConfigFingerprint) ||
    typeof record.trustedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.trustedAt))
  ) {
    return false
  }
  return record.repoConfigFingerprint === hashValue(canonicalStringify(rawConfig))
}
