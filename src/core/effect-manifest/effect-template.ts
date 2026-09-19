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
  'network.acquire',
  'git.ref.write',
  'secret.read',
  'control_plane.write',
  'read_only',
  'indeterminate',
])

function effectTagForAction(action: CapabilityAction): EffectTag {
  switch (action) {
    case 'fs.read':
      return 'fs.read'
    case 'fs.write':
      return 'fs.write'
    case 'process.exec':
      return 'process.exec'
    case 'network.connect':
      return 'network.connect'
    case 'secret.read':
      return 'secret.read'
    case 'git.ref.write':
      return 'git.ref.write'
    case 'control_plane.write':
      return 'control_plane.write'
    case 'indeterminate':
      return 'indeterminate'
    default:
      return 'indeterminate'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseManifestResource(raw: Record<string, unknown>): CapabilityResource | null {
  const kind = raw.kind
  if (kind === 'path') {
    return typeof raw.path === 'string' ? { kind: 'path', path: raw.path } : null
  }
  if (kind === 'unknown') {
    return { kind: 'unknown' }
  }
  if (kind === 'package-cache') {
    return raw.manager === 'npm' || raw.manager === 'pnpm'
      ? { kind: 'package-cache', manager: raw.manager }
      : null
  }
  if (kind === 'executable') {
    return typeof raw.command === 'string'
      ? {
          kind: 'executable',
          command: raw.command,
          operation:
            raw.operation === 'inspect' || raw.operation === 'spawn' || raw.operation === 'signal'
              ? raw.operation
              : undefined,
        }
      : null
  }
  if (kind === 'git-ref') {
    return typeof raw.ref === 'string'
      ? {
          kind: 'git-ref',
          ref: raw.ref,
          scope: raw.scope === 'local' || raw.scope === 'remote' ? raw.scope : undefined,
          repoPath: typeof raw.repoPath === 'string' ? raw.repoPath : undefined,
        }
      : null
  }
  if (kind === 'network') {
    if (typeof raw.host !== 'string') {
      return null
    }
    const mode =
      raw.mode === 'read' || raw.mode === 'mutate' || raw.mode === 'ambiguous'
        ? raw.mode
        : undefined
    const payload =
      raw.payload === 'none' || raw.payload === 'present' || raw.payload === 'secret'
        ? raw.payload
        : undefined
    return {
      kind: 'network',
      host: raw.host,
      port: typeof raw.port === 'number' ? raw.port : undefined,
      protocol: typeof raw.protocol === 'string' ? raw.protocol : undefined,
      mode,
      payload,
    }
  }
  return null
}

function resourceMatchesAction(action: CapabilityAction, resource: CapabilityResource): boolean {
  switch (action) {
    case 'fs.read':
      return resource.kind === 'path'
    case 'fs.write':
      return resource.kind === 'path' || resource.kind === 'package-cache'
    case 'process.exec':
      return resource.kind === 'executable'
    case 'network.connect':
      return (
        resource.kind === 'network' &&
        typeof resource.host === 'string' &&
        resource.mode !== undefined
      )
    case 'secret.read':
      return resource.kind === 'path'
    case 'git.ref.write':
      return resource.kind === 'git-ref'
    case 'control_plane.write':
      return resource.kind === 'path'
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
  const expectedTag = effectTagForAction(action)
  if (template.tag !== expectedTag) {
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
