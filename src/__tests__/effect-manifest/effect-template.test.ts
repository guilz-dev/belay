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
})
