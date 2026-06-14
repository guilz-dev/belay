import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzePathTargets, resolveTrustedPath } from '../../core/verdict/containment.js'
import { v2TestContext } from './helpers.js'

describe('containment', () => {
  const ctx = v2TestContext()

  it('resolves repo-local paths with trusted cwd', () => {
    const resolved = resolveTrustedPath('package.json', ctx.cwd, true)
    expect(resolved).toBe(path.resolve(ctx.cwd, 'package.json'))
  })

  it('marks .git destruction as high stakes', () => {
    const analysis = analyzePathTargets({
      targets: ['.git'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      trustedCwd: true,
      sensitivePaths: ctx.sensitivePaths,
    })
    expect(analysis.isHighStakes).toBe(true)
    expect(analysis.location).toBe('repo_local')
  })

  it('returns unknown location without trusted cwd', () => {
    const analysis = analyzePathTargets({
      targets: ['foo.txt'],
      cwd: '',
      repoRoot: ctx.repoRoot,
      trustedCwd: false,
      sensitivePaths: ctx.sensitivePaths,
    })
    expect(analysis.location).toBe('unknown')
    expect(analysis.signals).toContain('missing_trusted_cwd')
  })
})
