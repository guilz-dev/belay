import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const coreDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core')
const forbidden = ['.cursor', '.claude']

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(fullPath)))
      continue
    }
    if (entry.name.endsWith('.ts')) {
      files.push(fullPath)
    }
  }
  return files
}

describe('core host agnosticism', () => {
  it('does not embed adapter-specific directory names', async () => {
    const files = await listTsFiles(coreDir)
    const violations: string[] = []
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      for (const token of forbidden) {
        if (content.includes(token)) {
          violations.push(`${path.relative(coreDir, file)} contains ${token}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
