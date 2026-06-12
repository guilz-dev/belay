import { describe, expect, it } from 'vitest'
import { resolveLauncherRecipe } from '../../core/v2/launcher-resolve.js'
import { v2TestContext } from './helpers.js'

describe('v2 launcher-resolve', () => {
  const ctx = v2TestContext()

  it('resolves npm run build recipe', () => {
    const resolution = resolveLauncherRecipe({
      tokens: ['npm', 'run', 'build'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      depth: 0,
    })
    expect(resolution?.recipe).toBe('tsc -p tsconfig.json')
    expect(resolution?.opaque).toBe(false)
  })

  it('resolves npm test recipe', () => {
    const resolution = resolveLauncherRecipe({
      tokens: ['npm', 'test'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      depth: 0,
    })
    expect(resolution?.recipe).toBe('vitest run')
  })

  it('resolves make build recipe', () => {
    const resolution = resolveLauncherRecipe({
      tokens: ['make', 'build'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      depth: 0,
    })
    expect(resolution?.recipe).toBe('tsc -p tsconfig.json')
  })
})
