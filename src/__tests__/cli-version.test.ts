import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { PACKAGE_VERSION } from '../version.js'

const execFileAsync = promisify(execFile)
const root = path.join(import.meta.dirname, '..', '..')

describe('cli --version', () => {
  it('prints package.json version', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      version: string
    }
    const { stdout } = await execFileAsync('node', [path.join(root, 'dist/cli.js'), '--version'])
    expect(stdout.trim()).toBe(pkg.version)
  })

  it('keeps PACKAGE_VERSION in sync with package.json', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      version: string
    }
    expect(PACKAGE_VERSION).toBe(pkg.version)
  })
})
