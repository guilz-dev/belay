import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  MAX_EXECUTABLE_IDENTITY_BYTES,
  resolveNativeExecutableIdentity,
  verifyStoredExecutableIdentity,
} from '../../core/effect-manifest/executable-identity.js'

describe('executable identity hashing limits', () => {
  it('refuses executables larger than the gate hash budget', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-exe-limit-'))
    const binDir = path.join(repoRoot, 'bin')
    await mkdir(binDir, { recursive: true })
    const toolPath = path.join(binDir, 'huge-cli')
    await writeFile(toolPath, Buffer.alloc(MAX_EXECUTABLE_IDENTITY_BYTES + 1, 1), { mode: 0o755 })

    const resolved = resolveNativeExecutableIdentity(
      'huge-cli',
      repoRoot,
      `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    )
    expect(resolved).toEqual({ error: 'executable_too_large' })

    const manifestCommand = {
      basename: 'huge-cli',
      canonicalPath: toolPath,
      sha256: 'a'.repeat(64),
      kind: 'native' as const,
    }
    expect(verifyStoredExecutableIdentity(manifestCommand)).toBe('changed')
  })
})
