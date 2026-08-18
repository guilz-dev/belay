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
  CoverageMatrixSchemaError,
  parseCoverageMatrix,
} from '../../corpus/coverage-matrix.js'
import {
  type ClassifyFn,
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
                expectations: { audit: { verdict: 'allow' } },
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
  it('matches structural suite fixture root', () => {
    const [structural] = buildCoverageEvalContexts(['structural'], repoRoot)
    expect(structural.cwd).toBe(structuralFixtureRoot(repoRoot))
    expect(structural.repoRoot).toBe(structuralFixtureRoot(repoRoot))
    expect(structural.config.mode).toBe('enforce')
    expect(structural.options.unknownLocalEffect).toBe('deny')
    expect(structural.options.unparseableShell).toBe('deny')
    expect(structural.options.trustedCwd).toBe(true)
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
      contextIds: [...COVERAGE_CONTEXT_IDS],
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
    const [defaultContext] = buildCoverageEvalContexts(['default'], repoRoot)
    const result = await defaultClassifyFn('git status', defaultContext)
    expect(result.verdict).toBe('allow')
  })
})

function permissionToHookVerdict(permission: VerdictPermission): HookVerdict {
  return permission === 'ask' ? 'deny_pending_approval' : 'allow'
}

describe('structural context equivalence with structural suite', () => {
  const [structuralContext] = buildCoverageEvalContexts(['structural'], repoRoot)
  const suiteContext = verdictTestContext()

  it.each([
    ['git status', 'allow'],
    ['docker push myimage:latest', 'ask'],
    ['gh pr list', 'allow'],
    ['npm run deploy', 'ask'],
    ['curl https://example.com', 'allow'],
  ] as const)('%s matches structural suite permission', async (command, permission) => {
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

  it('rejects empty --context', () => {
    expect(() => parseCoverageProbeCliArgs(['--context', ''])).toThrow(CoverageMatrixSchemaError)
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
