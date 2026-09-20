import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { EffectManifestV1 } from '../../core/effect-manifest/types.js'

export async function bindManifestExecutableIdentity(
  repoRoot: string,
  manifest: EffectManifestV1,
): Promise<EffectManifestV1> {
  const toolPath = path.join(repoRoot, 'bin', manifest.command.basename)
  await mkdir(path.dirname(toolPath), { recursive: true })
  await writeFile(toolPath, `mock-${manifest.command.basename}\n`, { mode: 0o755 })
  const canonicalPath = realpathSync(toolPath)
  const sha256 = createHash('sha256').update(readFileSync(canonicalPath)).digest('hex')
  return {
    ...manifest,
    command: {
      ...manifest.command,
      canonicalPath,
      sha256,
    },
  }
}
