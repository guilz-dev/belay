import { describe, expect, it } from 'vitest'

import { validateManifestEffectTemplate } from '../../core/effect-manifest/effect-template.js'

describe('validateManifestEffectTemplate', () => {
  it('rejects tag and action mismatches', () => {
    const result = validateManifestEffectTemplate({
      tag: 'network.connect',
      action: 'fs.read',
      resource: { kind: 'network', host: 'example.com', mode: 'read' },
    })
    expect(result.ok).toBe(false)
  })

  it('accepts aligned fs.read templates', () => {
    const result = validateManifestEffectTemplate({
      tag: 'fs.read',
      action: 'fs.read',
      resource: { kind: 'path', path: '/tmp/example' },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects unknown resource fields and incomplete fixed network semantics', () => {
    expect(
      validateManifestEffectTemplate({
        tag: 'fs.read',
        action: 'fs.read',
        resource: { kind: 'path', path: '/tmp/example', harmless: true },
      }).ok,
    ).toBe(false)
    expect(
      validateManifestEffectTemplate({
        tag: 'network.connect',
        action: 'network.connect',
        resource: { kind: 'network', host: 'example.com', mode: 'read' },
      }).ok,
    ).toBe(false)
  })

  it('requires fixed process operations and git scopes', () => {
    expect(
      validateManifestEffectTemplate({
        tag: 'process.exec',
        action: 'process.exec',
        resource: { kind: 'executable', command: 'node' },
      }).ok,
    ).toBe(false)
    expect(
      validateManifestEffectTemplate({
        tag: 'git.ref.write',
        action: 'git.ref.write',
        resource: { kind: 'git-ref', ref: 'refs/heads/main' },
      }).ok,
    ).toBe(false)
  })
})
