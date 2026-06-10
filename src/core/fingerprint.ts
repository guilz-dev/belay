import { createHash } from 'node:crypto'

export function canonicalStringify(value: unknown): string {
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

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function shellFingerprint(cwdRelative: string, normalizedCommand: string): string {
  return hashValue(`shell:${cwdRelative}:${normalizedCommand}`)
}

export function subagentFingerprint(kind: string, scrubbed: unknown, repoRoot: string): string {
  return hashValue(`subagent:${kind}:${canonicalStringify(scrubbed)}:${repoRoot}`)
}

export function toolFingerprint(toolName: string, scrubbed: unknown, repoRoot: string): string {
  return hashValue(`tool:${toolName}:${canonicalStringify(scrubbed)}:${repoRoot}`)
}
