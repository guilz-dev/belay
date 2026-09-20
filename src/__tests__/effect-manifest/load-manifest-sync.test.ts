import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  loadEffectManifestSync,
  MAX_EFFECT_MANIFEST_BYTES,
} from '../../core/effect-manifest/load-manifest-sync.js'
import { manifestFilePath } from '../../core/effect-manifest/paths.js'

describe('loadEffectManifestSync', () => {
  it('rejects manifests larger than the gate read budget', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-oversized-'))
    const filePath = manifestFilePath(repoRoot, 'huge-cli')
    await mkdir(path.dirname(filePath), { recursive: true })
    const padding = 'x'.repeat(MAX_EFFECT_MANIFEST_BYTES)
    await writeFile(filePath, `{"schemaVersion":1,"padding":"${padding}"}`)

    const loaded = loadEffectManifestSync(repoRoot, 'huge-cli')
    expect(loaded.ok).toBe(false)
    if (loaded.ok) {
      throw new Error('expected load failure')
    }
    expect(loaded.reason).toBe('oversized')
  })

  it('rejects invalid UTF-8 before authority parsing', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-utf8-'))
    const filePath = manifestFilePath(repoRoot, 'bad-cli')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))
    const loaded = loadEffectManifestSync(repoRoot, 'bad-cli')
    expect(loaded.ok).toBe(false)
  })
})
