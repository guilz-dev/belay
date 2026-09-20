import { renameSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
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

  it('skips non-executable PATH entries instead of binding trust to them', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-exe-mode-'))
    const first = path.join(repoRoot, 'first')
    const second = path.join(repoRoot, 'second')
    await mkdir(first)
    await mkdir(second)
    await writeFile(path.join(first, 'demo'), 'not executable\n', { mode: 0o644 })
    await writeFile(path.join(second, 'demo'), 'executable\n', { mode: 0o755 })

    const resolved = resolveNativeExecutableIdentity(
      'demo',
      repoRoot,
      `${first}${path.delimiter}${second}`,
    )
    expect(resolved).not.toHaveProperty('error')
    if ('error' in resolved) {
      throw new Error(resolved.error)
    }
    expect(resolved.canonicalPath).toBe(await realpath(path.join(second, 'demo')))
    await chmod(resolved.canonicalPath, 0o644)
    expect(verifyStoredExecutableIdentity(resolved)).toBe('not_executable')
  })

  it('resolves relative PATH entries from the action working directory', async () => {
    const actionCwd = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-relative-path-'))
    const binDir = path.join(actionCwd, 'tools', 'bin')
    await mkdir(binDir, { recursive: true })
    const toolPath = path.join(binDir, 'demo')
    await writeFile(toolPath, 'native fixture\n', { mode: 0o755 })

    const resolved = resolveNativeExecutableIdentity('demo', actionCwd, path.join('tools', 'bin'))
    expect(resolved).not.toHaveProperty('error')
    if ('error' in resolved) {
      throw new Error(resolved.error)
    }
    expect(resolved.canonicalPath).toBe(await realpath(toolPath))
  })

  it('binds script identity to its absolute shebang interpreter', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-script-'))
    const interpreter = path.join(repoRoot, 'interpreter')
    const script = path.join(repoRoot, 'demo')
    await writeFile(interpreter, 'interpreter-v1\n', { mode: 0o755 })
    await writeFile(script, `#!${interpreter}\necho demo\n`, { mode: 0o755 })
    await chmod(script, 0o755)

    const resolved = resolveNativeExecutableIdentity('./demo', repoRoot, '')
    expect(resolved).not.toHaveProperty('error')
    if ('error' in resolved) {
      throw new Error(resolved.error)
    }
    expect(resolved.kind).toBe('script')
    expect(resolved.interpreter?.canonicalPath).toBe(await realpath(interpreter))
    expect(resolved.interpreter?.sha256).toMatch(/^[a-f0-9]{64}$/)

    await writeFile(interpreter, `${await readFile(interpreter, 'utf8')}changed\n`)
    expect(verifyStoredExecutableIdentity(resolved)).toBe('changed')
  })

  it('marks ambiguous script interpreters ineligible', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-script-bad-'))
    const script = path.join(repoRoot, 'demo')
    await writeFile(script, '#!/bin/sh -c\necho demo\n', { mode: 0o755 })
    const resolved = resolveNativeExecutableIdentity('./demo', repoRoot, process.env.PATH ?? '')
    expect(resolved).toEqual({ error: 'unsupported_script_interpreter' })
  })

  it('rejects an executable path atomically replaced while its bytes are hashed', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-exe-race-'))
    const toolPath = path.join(repoRoot, 'demo')
    const replacementPath = path.join(repoRoot, 'replacement')
    await writeFile(toolPath, 'first executable\n', { mode: 0o755 })
    await writeFile(replacementPath, 'second executable\n', { mode: 0o755 })

    const resolved = resolveNativeExecutableIdentity('./demo', repoRoot, '', {
      afterFileRead(filePath) {
        renameSync(replacementPath, filePath)
      },
    })
    expect(resolved).toEqual({ error: 'executable_changed_during_read' })
  })

  it('rejects a stored identity when its path is replaced during verification', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-verify-race-'))
    const toolPath = path.join(repoRoot, 'demo')
    const replacementPath = path.join(repoRoot, 'replacement')
    await writeFile(toolPath, 'first executable\n', { mode: 0o755 })
    const identity = resolveNativeExecutableIdentity('./demo', repoRoot, '')
    if ('error' in identity) {
      throw new Error(identity.error)
    }
    await writeFile(replacementPath, 'second executable\n', { mode: 0o755 })

    const status = verifyStoredExecutableIdentity(identity, {
      afterFileRead(filePath) {
        renameSync(replacementPath, filePath)
      },
    })
    expect(status).toBe('changed')
  })
})
