import { access } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

describe('gate runtime architecture boundary', () => {
  it('keeps observed audit next to gate runtime without a horizontal application layer', async () => {
    await expect(
      pathExists(path.join(REPO_ROOT, 'src/adapters/shared/gate-runtime/observed-audit.ts')),
    ).resolves.toBe(true)
    await expect(pathExists(path.join(REPO_ROOT, 'src/application'))).resolves.toBe(false)
  })
})
