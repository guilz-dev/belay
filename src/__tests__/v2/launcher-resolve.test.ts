import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveLauncherRecipe } from '../../core/v2/launcher-resolve.js'
import { verdict } from '../../core/v2/verdict.js'
import { v2TestContext } from './helpers.js'

describe('v2 launcher-resolve', () => {
  const ctx = v2TestContext()
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rmSafe(dir)))
  })

  it('resolves npm run build recipe', () => {
    const resolution = resolveLauncherRecipe({
      tokens: ['npm', 'run', 'build'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      depth: 0,
    })
    expect(resolution?.recipes).toEqual(['tsc -p tsconfig.json'])
    expect(resolution?.opaque).toBe(false)
  })

  it('appends npm forwarded args after -- to the resolved recipe', () => {
    const resolution = resolveLauncherRecipe({
      tokens: ['npm', 'run', 'build', '--', '--outDir', '../published'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      depth: 0,
    })
    expect(resolution?.recipes).toEqual(['tsc -p tsconfig.json --outDir ../published'])
    expect(resolution?.opaque).toBe(false)
  })

  it('appends pnpm forwarded args after -- to the resolved recipe', () => {
    const resolution = resolveLauncherRecipe({
      tokens: ['pnpm', 'run', 'build', '--', '--outDir', '../published'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      depth: 0,
    })
    expect(resolution?.recipes).toEqual(['tsc -p tsconfig.json --outDir ../published'])
  })

  it('resolves npm test recipe', () => {
    const resolution = resolveLauncherRecipe({
      tokens: ['npm', 'test'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      depth: 0,
    })
    expect(resolution?.recipes).toEqual(['vitest run'])
  })

  it('resolves make build recipe as separate lines', () => {
    const resolution = resolveLauncherRecipe({
      tokens: ['make', 'build'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      depth: 0,
    })
    expect(resolution?.recipes).toEqual(['tsc -p tsconfig.json'])
  })

  it('keeps multi-line make recipes as separate commands', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-make-lines-'))
    tempDirs.push(dir)
    await writeFile(
      path.join(dir, 'Makefile'),
      'build:\n\ttsc -p tsconfig.json\n\tcurl https://evil.example\n',
    )

    const resolution = resolveLauncherRecipe({
      tokens: ['make', 'build'],
      cwd: dir,
      repoRoot: dir,
      depth: 0,
    })
    expect(resolution?.recipes).toEqual(['tsc -p tsconfig.json', 'curl https://evil.example'])
  })

  it('classifies npm forwarded args against the effective invocation', async () => {
    const result = await verdict('npm run build -- --outDir ../published', ctx)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('repo_outside_mutation')
  })

  it('classifies each line of a multi-line make target', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-make-verdict-'))
    tempDirs.push(dir)
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'Makefile'),
      'build:\n\ttsc -p tsconfig.json\n\tcurl https://evil.example\n',
    )

    const result = await verdict('make build', { ...ctx, cwd: dir, repoRoot: dir })
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('tier0_external')
    expect(result.effect).toBe('remote_mutation')
  })
})

async function rmSafe(dir: string) {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // ignore cleanup failures
  }
}
