import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifierOptionsFromConfig, DEFAULT_CONFIG_V3 } from '../../core/config.js'
import { classifyShell } from '../../core/verdict/adapter.js'
import { generateProbeCases } from '../../corpus/adversarial-probe.js'
import { evaluateCommandBatch } from '../../corpus/evaluate.js'
import { AUTO_LABEL_MUTATORS, CATASTROPHIC_CORES } from '../../corpus/mutators.js'
import { defaultCorpusEvalPaths } from '../../corpus/runtime-match.js'

/**
 * Corpus / probe evaluation harness: cwd under repo src + DEFAULT_CONFIG_V3.
 * Structural-suite uses repo-root cwd and deny policy — this file guards the probe path.
 */
describe('corpus eval context (probe-aligned)', () => {
  const { repoRoot, cwd } = defaultCorpusEvalPaths()
  const options = classifierOptionsFromConfig(DEFAULT_CONFIG_V3)

  it('denies rm -rf .git wrappers from subdirectory cwd (nested .git resolution)', async () => {
    const commands = [
      'rm -rf .git',
      "bash -c 'rm -rf .git'",
      'env FOO=1 rm -rf .git',
      '(rm -rf .git)',
    ]
    for (const command of commands) {
      const result = await classifyShell(command, cwd, repoRoot, DEFAULT_CONFIG_V3, options)
      expect(result.verdict, command).toBe('deny_pending_approval')
    }
  })

  it('AUTO_LABEL mutations on catastrophic cores are must-ask under corpus harness', async () => {
    const cases = generateProbeCases(42)
    const results = await evaluateCommandBatch(
      cases.map((entry) => ({
        command: entry.command,
        expected: 'deny_pending_approval' as const,
        core: entry.core,
        mutatorId: entry.mutatorId,
      })),
      repoRoot,
    )
    const failures = results.filter((r) => r.isFn)
    expect(failures, failures.map((f) => f.command).join(', ')).toHaveLength(0)
  })

  it('uses subdirectory cwd distinct from repo root', () => {
    expect(cwd).toBe(path.join(repoRoot, 'src'))
    expect(cwd).not.toBe(repoRoot)
  })

  it('covers all catastrophic cores × auto-label mutators', () => {
    const cases = generateProbeCases(1)
    expect(cases).toHaveLength(CATASTROPHIC_CORES.length * AUTO_LABEL_MUTATORS.length)
  })
})
