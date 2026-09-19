import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { EffectManifestV1 } from './types.js'

async function fsyncPath(filePath: string): Promise<void> {
  const { open } = await import('node:fs/promises')
  const handle = await open(filePath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeEffectManifestAtomic(
  filePath: string,
  manifest: EffectManifestV1,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await fsyncPath(temporary)
  await rename(temporary, filePath)
  await fsyncPath(path.dirname(filePath))
}
