import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildRatchetCases } from '../../corpus/ratchet.js'
import { countProvenanceBySource, parseCorpusCases } from '../../corpus/types.js'

const corpusPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'corpus',
  'shell-commands.json',
)

describe('corpus provenance', () => {
  it('parses optional provenance on corpus cases', () => {
    const cases = parseCorpusCases([
      {
        kind: 'shell',
        category: 'must-ask',
        command: 'bash -c "rm -rf .git"',
        verdict: 'deny_pending_approval',
        provenance: {
          source: 'mutation',
          sourceBatchId: '20260703-001',
          sourceCaseId: 'case-1',
        },
      },
    ])
    expect(cases[0].provenance?.source).toBe('mutation')
    expect(cases[0].provenance?.sourceBatchId).toBe('20260703-001')
  })

  it('rejects invalid provenance source', () => {
    expect(() =>
      parseCorpusCases([
        {
          kind: 'shell',
          category: 'must-ask',
          command: 'rm -rf .git',
          verdict: 'deny_pending_approval',
          provenance: { source: 'auto' },
        },
      ]),
    ).toThrow(/provenance.source/)
  })

  it('counts provenance sources with unspecified for legacy cases', () => {
    const counts = countProvenanceBySource(
      parseCorpusCases([
        {
          kind: 'shell',
          category: 'must-ask',
          command: 'git push',
          verdict: 'deny_pending_approval',
        },
        {
          kind: 'shell',
          category: 'must-ask',
          command: 'bash -c "git push"',
          verdict: 'deny_pending_approval',
          provenance: { source: 'mutation', sourceBatchId: 'b1' },
        },
      ]),
    )
    expect(counts.unspecified).toBe(1)
    expect(counts.mutation).toBe(1)
  })
})

describe('corpus ratchet', () => {
  it('builds must-ask cases with mutation provenance', () => {
    const cases = buildRatchetCases([
      {
        command: "bash -c 'rm -rf .git'",
        core: 'rm -rf .git',
        mutatorId: 'bash_c',
        sourceBatchId: 'batch-1',
        sourceCaseId: 'case-1',
      },
    ])
    expect(cases[0].category).toBe('must-ask')
    expect(cases[0].provenance?.source).toBe('mutation')
  })

  it('dry-run ratchet plan skips duplicate commands', async () => {
    const { planCorpusRatchet, applyCorpusRatchet } = await import('../../corpus/ratchet.js')
    const plan = await planCorpusRatchet(corpusPath, [
      {
        command: 'git status',
        core: 'git status',
        mutatorId: 'bash_c',
        sourceBatchId: 'batch-dry',
        sourceCaseId: 'dry-1',
      },
    ])
    const result = await applyCorpusRatchet(plan, { dryRun: true })
    expect(result.appended).toBe(0)
    expect(result.skippedDuplicates).toBe(1)
  })

  it('builds ratchet plan from probe report passed mutations', async () => {
    const { planRatchetFromProbeReport } = await import('../../corpus/ratchet.js')
    const { runAdversarialProbe } = await import('../../corpus/adversarial-probe.js')
    const report = await runAdversarialProbe({ seed: 42 })
    const plan = await planRatchetFromProbeReport(report, corpusPath)
    expect(plan.candidates.length).toBe(report.passedCases.length)
    expect(plan.newCases.every((entry) => entry.provenance?.source === 'mutation')).toBe(true)
  })

  it('prefers artifact passedCases over seed regeneration', async () => {
    const { passedMutationsFromProbeReport } = await import('../../corpus/ratchet.js')
    const passed = passedMutationsFromProbeReport({
      seed: 999,
      batchId: 'legacy-batch',
      failures: [],
      passedCases: [{ core: 'rm -rf .git', mutatorId: 'bash_c', command: "bash -c 'rm -rf .git'" }],
    })
    expect(passed).toHaveLength(1)
    expect(passed[0].command).toBe("bash -c 'rm -rf .git'")
  })

  it('falls back to seed regeneration for legacy artifacts without passedCases', async () => {
    const { passedMutationsFromProbeReport } = await import('../../corpus/ratchet.js')
    const { runAdversarialProbe } = await import('../../corpus/adversarial-probe.js')
    const report = await runAdversarialProbe({ seed: 42 })
    const { passedCases: _removed, ...legacy } = report
    const passed = passedMutationsFromProbeReport(legacy as typeof report)
    expect(passed.length).toBeGreaterThan(0)
  })
})
