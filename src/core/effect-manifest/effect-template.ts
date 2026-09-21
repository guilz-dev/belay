import path from 'node:path'

import type { CapabilityAction, CapabilityResource } from '../capability/request.js'
import type { EffectTag } from '../effect-ir/types.js'
import type { ManifestEffectTemplateV1 } from './types.js'

const CAPABILITY_ACTIONS = new Set<CapabilityAction>([
  'fs.read',
  'fs.write',
  'process.exec',
  'network.connect',
  'secret.read',
  'git.ref.write',
  'control_plane.write',
  'indeterminate',
])

const EFFECT_TAGS = new Set<EffectTag>([
  'fs.read',
  'fs.write',
  'process.exec',
  'network.connect',
  'git.ref.write',
  'secret.read',
  'control_plane.write',
  'indeterminate',
])

const TEMPLATE_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function effectTagForAction(action: CapabilityAction): EffectTag {
  return action as EffectTag
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(record).every((key) => allowed.has(key))
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function isPortTemplate(value: unknown): boolean {
  return (
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535) ||
    (typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))
  )
}

function parseManifestResource(raw: Record<string, unknown>): CapabilityResource | null {
  const kind = raw.kind
  if (kind === 'path') {
    return hasOnlyKeys(raw, ['kind', 'path']) && isString(raw.path)
      ? ({ kind: 'path', path: raw.path } as CapabilityResource)
      : null
  }
  if (kind === 'unknown') {
    return hasOnlyKeys(raw, ['kind']) ? { kind: 'unknown' } : null
  }
  if (kind === 'executable') {
    return hasOnlyKeys(raw, ['kind', 'command', 'operation']) &&
      isString(raw.command) &&
      (raw.operation === 'inspect' || raw.operation === 'spawn' || raw.operation === 'signal')
      ? { kind: 'executable', command: raw.command, operation: raw.operation }
      : null
  }
  if (kind === 'git-ref') {
    return hasOnlyKeys(raw, ['kind', 'ref', 'scope', 'repoPath']) &&
      isString(raw.ref) &&
      (raw.scope === 'local' || raw.scope === 'remote') &&
      (raw.repoPath === undefined || isString(raw.repoPath))
      ? {
          kind: 'git-ref',
          ref: raw.ref,
          scope: raw.scope,
          ...(typeof raw.repoPath === 'string' ? { repoPath: raw.repoPath } : {}),
        }
      : null
  }
  if (kind === 'network') {
    if (
      !hasOnlyKeys(raw, ['kind', 'host', 'port', 'protocol', 'mode', 'payload']) ||
      !isString(raw.host) ||
      !isString(raw.protocol) ||
      (raw.mode !== 'read' && raw.mode !== 'mutate' && raw.mode !== 'ambiguous') ||
      (raw.payload !== 'none' && raw.payload !== 'present' && raw.payload !== 'secret') ||
      (raw.port !== undefined && !isPortTemplate(raw.port))
    ) {
      return null
    }
    return {
      kind: 'network',
      host: raw.host,
      protocol: raw.protocol,
      mode: raw.mode,
      payload: raw.payload,
      ...(typeof raw.port === 'number' ? { port: raw.port } : {}),
    }
  }
  return null
}

function resourceMatchesAction(action: CapabilityAction, resource: CapabilityResource): boolean {
  switch (action) {
    case 'fs.read':
    case 'secret.read':
    case 'control_plane.write':
      return resource.kind === 'path'
    case 'fs.write':
      return resource.kind === 'path'
    case 'process.exec':
      return resource.kind === 'executable'
    case 'network.connect':
      return resource.kind === 'network'
    case 'git.ref.write':
      return resource.kind === 'git-ref'
    case 'indeterminate':
      return resource.kind === 'unknown'
    default:
      return false
  }
}

export function validateManifestEffectTemplate(
  template: ManifestEffectTemplateV1,
): { ok: true; resource: CapabilityResource } | { ok: false; message: string } {
  if (!EFFECT_TAGS.has(template.tag as EffectTag)) {
    return { ok: false, message: `Unknown effect tag ${template.tag}.` }
  }
  if (!CAPABILITY_ACTIONS.has(template.action as CapabilityAction)) {
    return { ok: false, message: `Unknown effect action ${template.action}.` }
  }
  const action = template.action as CapabilityAction
  if (template.tag !== effectTagForAction(action)) {
    return {
      ok: false,
      message: `Effect tag ${template.tag} does not match action ${action}.`,
    }
  }
  if (!isRecord(template.resource)) {
    return { ok: false, message: 'Effect resource must be an object.' }
  }
  const resource = parseManifestResource(template.resource)
  if (!resource) {
    return { ok: false, message: 'Effect resource schema is invalid.' }
  }
  if (!resourceMatchesAction(action, resource)) {
    return {
      ok: false,
      message: `Effect resource kind ${resource.kind} is incompatible with action ${action}.`,
    }
  }
  return { ok: true, resource }
}

export function captureReferencesInTemplate(template: ManifestEffectTemplateV1): Set<string> {
  const references = new Set<string>()
  for (const value of Object.values(template.resource)) {
    if (typeof value !== 'string') {
      continue
    }
    for (const match of value.matchAll(TEMPLATE_REFERENCE)) {
      const name = match[1]
      if (name) {
        references.add(name)
      }
    }
  }
  return references
}

function substitute(
  value: unknown,
  captures: Readonly<Record<string, string>>,
  numeric: boolean,
): unknown {
  if (typeof value !== 'string') {
    return value
  }
  const exact = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  if (numeric && exact?.[1] && /^-?(?:0|[1-9]\d*)$/.test(captures[exact[1]] ?? '')) {
    return Number(captures[exact[1]])
  }
  let unresolved = false
  const result = value.replace(TEMPLATE_REFERENCE, (_whole, name: string) => {
    const capture = captures[name]
    if (capture === undefined) {
      unresolved = true
      return ''
    }
    return capture
  })
  return unresolved ? null : result
}

export function instantiateManifestEffectTemplate(
  template: ManifestEffectTemplateV1,
  captures: Readonly<Record<string, string>>,
  cwd: string,
): { ok: true; resource: CapabilityResource } | { ok: false } {
  const resource: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(template.resource)) {
    const instantiated = substitute(value, captures, key === 'port')
    if (instantiated === null) {
      return { ok: false }
    }
    resource[key] = instantiated
  }
  if (resource.kind === 'path' && typeof resource.path === 'string') {
    resource.path = path.resolve(cwd, resource.path)
  }
  if (resource.kind === 'git-ref' && typeof resource.repoPath === 'string') {
    resource.repoPath = path.resolve(cwd, resource.repoPath)
  }
  const validated = validateManifestEffectTemplate({ ...template, resource })
  return validated.ok ? validated : { ok: false }
}
