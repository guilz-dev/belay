import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { HookVerdict } from '../../core/types.js'
import type { VerdictPermission } from '../../core/verdict/types.js'
import { verdict } from '../../core/verdict/verdict.js'
import { buildCoverageEvalContexts } from '../../corpus/coverage-contexts.js'
import {
  assertKnownContextIds,
  COVERAGE_CONTEXT_IDS,
  DEFAULT_PROBE_CONTEXT_IDS,
  CoverageMatrixSchemaError,
  parseCoverageMatrix,
} from '../../corpus/coverage-matrix.js'
import {
  compareCoverageReports,
} from '../../corpus/coverage-compare.js'
import {
  type ClassifyFn,
  type CoverageProbeReport,
  CoverageProbeCliError,
  defaultClassifyFn,
  evaluateCoverageMatrix,
  parseCoverageProbeCliArgs,
  runCoverageProbe,
} from '../../corpus/coverage-probe.js'
import { structuralFixtureRoot } from '../../corpus/structural-fixture-root.js'
import { verdictTestContext } from '../verdict/helpers.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const minimalMatrix = {
  version: 1,
  groups: [
    {
      id: 'sample',
      label: 'Sample',
      cases: [
        {
          id: 'sample.allow',
          command: 'git status',
          tags: ['git'],
          expectations: {
            default: { verdict: 'allow' },
            structural: { verdict: 'allow' },
          },
        },
        {
          id: 'sample.observe',
          command: 'python3 -c "print(1)"',
          tags: ['python'],
        },
      ],
    },
  ],
}

describe('coverage matrix loader', () => {
  it('rejects duplicate group ids', () => {
    expect(() =>
      parseCoverageMatrix({
        version: 1,
        groups: [
          { id: 'a', label: 'A', cases: [{ id: 'x', command: 'ls', tags: ['t'] }] },
          { id: 'a', label: 'B', cases: [{ id: 'y', command: 'pwd', tags: ['t'] }] },
        ],
      }),
    ).toThrow(CoverageMatrixSchemaError)
  })

  it('rejects duplicate case ids across groups', () => {
    expect(() =>
      parseCoverageMatrix({
        version: 1,
        groups: [
          { id: 'a', label: 'A', cases: [{ id: 'dup', command: 'ls', tags: ['t'] }] },
          { id: 'b', label: 'B', cases: [{ id: 'dup', command: 'pwd', tags: ['t'] }] },
        ],
      }),
    ).toThrow(CoverageMatrixSchemaError)
  })

  it('accepts audit expectation context', () => {
    const matrix = parseCoverageMatrix({
      version: 1,
      groups: [
        {
          id: 'a',
          label: 'A',
          cases: [
            {
              id: 'x',
              command: 'ls',
              tags: ['t'],
              expectations: { audit: { verdict: 'allow' } },
            },
          ],
        },
      ],
    })
    expect(matrix.groups[0]?.cases[0]?.expectations?.audit?.verdict).toBe('allow')
  })

  it('rejects empty tags and unknown expectation contexts', () => {
    expect(() =>
      parseCoverageMatrix({
        version: 1,
        groups: [
          {
            id: 'a',
            label: 'A',
            cases: [{ id: 'x', command: 'ls', tags: [] }],
          },
        ],
      }),
    ).toThrow(CoverageMatrixSchemaError)

    expect(() =>
      parseCoverageMatrix({
        version: 1,
        groups: [
          {
            id: 'a',
            label: 'A',
            cases: [
              {
                id: 'x',
                command: 'ls',
                tags: ['t'],
                expectations: { unknown: { verdict: 'allow' } },
              },
            ],
          },
        ],
      }),
    ).toThrow(CoverageMatrixSchemaError)
  })

  it('rejects empty context list', () => {
    expect(() => assertKnownContextIds([])).toThrow(CoverageMatrixSchemaError)
  })
})

describe('coverage contexts', () => {
  it('matches structural suite fixture root', async () => {
    const [structural] = await buildCoverageEvalContexts(['structural'], repoRoot)
    expect(structural.cwd).toBe(structuralFixtureRoot(repoRoot))
    expect(structural.repoRoot).toBe(structuralFixtureRoot(repoRoot))
    expect(structural.config.mode).toBe('enforce')
    expect(structural.options.unknownLocalEffect).toBe('deny')
    expect(structural.options.unparseableShell).toBe('deny')
    expect(structural.options.trustedCwd).toBe(true)
  })

  it('loads audit context from layered config with provenance', async () => {
    const [audit] = await buildCoverageEvalContexts(['audit'], repoRoot)
    expect(audit.id).toBe('audit')
    expect(audit.cwd).toBe(path.resolve(repoRoot))
    expect(audit.repoRoot).toBe(path.resolve(repoRoot))
    expect(Array.isArray(audit.configProvenance)).toBe(true)
  })
})

describe('coverage probe runner', () => {
  it('routes fixture commands only through injected classifier', async () => {
    const classifyFn = vi.fn<ClassifyFn>(async (command) => ({
      verdict: 'allow',
      reason: 'read_only',
      fingerprint: `fp:${command}`,
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'repo_local',
        confidence: 0.95,
        signals: [],
      },
    }))

    const matrix = parseCoverageMatrix(minimalMatrix)
    const results = await evaluateCoverageMatrix(matrix, {
      contextIds: [...DEFAULT_PROBE_CONTEXT_IDS],
      repoRoot,
      classifyFn,
    })

    expect(classifyFn).toHaveBeenCalledTimes(4)
    expect(results.some((result) => result.observeOnly)).toBe(true)
    expect(results.some((result) => result.match === true)).toBe(true)
  })

  it('does not count observe-only rows as mismatches', async () => {
    const matrix = parseCoverageMatrix(minimalMatrix)
    const classifyFn: ClassifyFn = async () => ({
      verdict: 'deny_pending_approval',
      reason: 'external_effect',
      fingerprint: 'fp',
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: 'external',
        confidence: 0.95,
        signals: [],
      },
    })

    const results = await evaluateCoverageMatrix(matrix, { contextIds: ['default'], classifyFn })
    const mismatches = results.filter((result) => !result.observeOnly && result.match === false)
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]?.caseId).toBe('sample.allow')
  })
})

describe('defaultClassifyFn integration', () => {
  it('classifies git status as allow in default context', async () => {
    const [defaultContext] = await buildCoverageEvalContexts(['default'], repoRoot)
    const result = await defaultClassifyFn('git status', defaultContext)
    expect(result.verdict).toBe('allow')
  })
})

function permissionToHookVerdict(permission: VerdictPermission): HookVerdict {
  return permission === 'ask' ? 'deny_pending_approval' : 'allow'
}

describe('structural context equivalence with structural suite', () => {
  it.each([
    ['git status', 'allow'],
    ['docker push myimage:latest', 'ask'],
    ['gh pr list', 'allow'],
    ['npm run deploy', 'ask'],
    ['curl https://example.com', 'allow'],
  ] as const)('%s matches structural suite permission', async (command, permission) => {
    const [structuralContext] = await buildCoverageEvalContexts(['structural'], repoRoot)
    const suiteContext = verdictTestContext()
    const suiteResult = await verdict(command, suiteContext)
    const probeResult = await defaultClassifyFn(command, structuralContext)
    expect(suiteResult.permission).toBe(permission)
    expect(probeResult.verdict).toBe(permissionToHookVerdict(permission))
  })
})

describe('coverage probe CLI validation', () => {
  it('rejects empty --filter values', () => {
    expect(() => parseCoverageProbeCliArgs(['--filter', '  , '])).toThrow(CoverageProbeCliError)
  })

  it('rejects invalid --repeat', () => {
    expect(() => parseCoverageProbeCliArgs(['--repeat', '0'])).toThrow(CoverageProbeCliError)
    expect(() => parseCoverageProbeCliArgs(['--repeat', 'abc'])).toThrow(CoverageProbeCliError)
  })

  it('accepts audit in --context', () => {
    const parsed = parseCoverageProbeCliArgs(['--context', 'default,audit'])
    expect(parsed.contextIds).toEqual(['default', 'audit'])
  })

  it('rejects empty --context', () => {
    expect(() => parseCoverageProbeCliArgs(['--context', ''])).toThrow(CoverageMatrixSchemaError)
  })
})

describe('coverage compare', () => {
  function minimalReport(overrides: Partial<CoverageProbeReport> = {}): CoverageProbeReport {
    return {
      reportSchemaVersion: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      packageVersion: '0.0.0',
      gitSha: null,
      matrixPath: '/tmp/matrix.json',
      matrixHash: 'matrix-a',
      repeat: 1,
      driftRuns: 0,
      contexts: [
        {
          id: 'default',
          cwd: '/workspace/project/src',
          repoRoot: '/workspace/project',
          resolvedConfigHash: 'cfg-a',
        },
      ],
      summary: {
        total: 1,
        observeOnly: 0,
        matched: 1,
        mismatched: 0,
        filteredEmpty: false,
        byGroup: {},
        byTag: {},
      },
      results: [
        {
          caseId: 'sample.allow',
          groupId: 'sample',
          command: 'git status',
          commandHash: 'cmd-a',
          context: 'default',
          tags: ['git'],
          observeOnly: false,
          expectation: { verdict: 'allow' },
          expectationHash: 'exp-a',
          actual: { verdict: 'allow', reason: 'read_only', fingerprint: 'fp' },
          match: true,
        },
      ],
      mismatches: [],
      ...overrides,
    }
  }

  it('separates fixture changes from classifier drift', () => {
    const baseline = minimalReport()
    const fixtureChanged = minimalReport({
      matrixHash: 'matrix-b',
      results: [
        {
          ...baseline.results[0]!,
          commandHash: 'cmd-b',
          actual: { verdict: 'deny_pending_approval', reason: 'external_effect', fingerprint: 'fp2' },
          match: false,
        },
      ],
    })
    const classifierDrift = minimalReport({
      results: [
        {
          ...baseline.results[0]!,
          actual: { verdict: 'deny_pending_approval', reason: 'external_effect', fingerprint: 'fp2' },
          match: false,
        },
      ],
    })

    expect(compareCoverageReports(baseline, fixtureChanged).entries[0]?.kind).toBe('fixture_change')
    expect(compareCoverageReports(baseline, classifierDrift).entries[0]?.kind).toBe('classifier_drift')
  })

  it('reports config drift without failing compare', () => {
    const baseline = minimalReport()
    const current = minimalReport({
      contexts: [{ ...baseline.contexts[0]!, resolvedConfigHash: 'cfg-b' }],
    })
    const compareReport = compareCoverageReports(baseline, current)
    expect(compareReport.configDrift).toHaveLength(1)
    expect(compareReport.entries).toHaveLength(0)
  })
})

describe('coverage probe empty filter', () => {
  it('marks filteredEmpty when no cases match', async () => {
    const report = await runCoverageProbe({
      repoRoot,
      filters: ['definitely-not-a-real-tag'],
    })
    expect(report.summary.total).toBe(0)
    expect(report.summary.filteredEmpty).toBe(true)
  })
})
