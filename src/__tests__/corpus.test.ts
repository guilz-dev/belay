import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assessmentsDiverge,
  CorpusSchemaError,
  deriveShellCorpusRuntimeKey,
  enrichProvablyBenignRuntimeKeys,
  loadCorpusCases,
  parseCorpusCases,
  provablyBenignShellRuntimeKeys,
} from '../corpus/evaluate.js'

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')

describe('corpus evaluation', () => {
  it('detects prediction vs observation assessment divergence', () => {
    expect(
      assessmentsDiverge(
        {
          reversibility: 'reversible',
          external: false,
          blastRadius: 'single file',
          confidence: 0.72,
          signals: [],
        },
        {
          reversibility: 'irreversible',
          external: false,
          blastRadius: 'directory tree',
          confidence: 1,
          signals: ['transactional_observed'],
        },
      ),
    ).toBe(true)
  })

  it('loads shell corpus with labeled categories and derived runtime keys', async () => {
    const cases = await loadCorpusCases(corpusDir)
    expect(cases).toHaveLength(27)
    expect(cases.every((entry) => entry.kind === 'shell')).toBe(true)

    const counts = {
      'must-ask': cases.filter((entry) => entry.category === 'must-ask').length,
      'provably-benign': cases.filter((entry) => entry.category === 'provably-benign').length,
      'accepted-benign': cases.filter((entry) => entry.category === 'accepted-benign').length,
    }
    expect(counts).toEqual({
      'must-ask': 14,
      'provably-benign': 7,
      'accepted-benign': 6,
    })

    const provablyBenign = cases.filter((entry) => entry.category === 'provably-benign')
    expect(provablyBenign.every((entry) => entry.runtimeKey && entry.runtimeKey.length > 0)).toBe(
      true,
    )
    expect(new Set(provablyBenignShellRuntimeKeys(cases)).size).toBe(provablyBenign.length)
  })

  it('rejects schema without kind and category', () => {
    expect(() =>
      parseCorpusCases([{ command: 'git status', verdict: 'allow', reason: 'read_only' }]),
    ).toThrow(CorpusSchemaError)
  })

  it('rejects must-ask cases that expect allow', () => {
    expect(() =>
      parseCorpusCases([
        {
          kind: 'shell',
          category: 'must-ask',
          command: 'git push',
          verdict: 'allow',
        },
      ]),
    ).toThrow(/must-ask requires verdict deny_pending_approval/)
  })

  it('rejects provably-benign cases that expect allow_flagged', () => {
    expect(() =>
      parseCorpusCases([
        {
          kind: 'shell',
          category: 'provably-benign',
          command: 'git status',
          verdict: 'allow_flagged',
        },
      ]),
    ).toThrow(/provably-benign requires verdict allow/)
  })

  it('rejects accepted-benign cases that expect allow', () => {
    expect(() =>
      parseCorpusCases([
        {
          kind: 'shell',
          category: 'accepted-benign',
          command: 'touch x',
          verdict: 'allow',
        },
      ]),
    ).toThrow(/accepted-benign requires verdict allow_flagged/)
  })

  it('rejects accepted-benign cases that expect deny', () => {
    expect(() =>
      parseCorpusCases([
        {
          kind: 'shell',
          category: 'accepted-benign',
          command: 'touch x',
          verdict: 'deny_pending_approval',
        },
      ]),
    ).toThrow(/accepted-benign requires verdict allow_flagged/)
  })

  it('rejects runtimeKey on non-provably-benign cases', () => {
    expect(() =>
      parseCorpusCases([
        {
          kind: 'shell',
          category: 'must-ask',
          command: 'git push',
          verdict: 'deny_pending_approval',
          runtimeKey: 'fp1',
        },
      ]),
    ).toThrow(/runtimeKey is only valid for provably-benign/)
  })

  it('derives stable runtime keys for provably-benign shell cases', async () => {
    const cases = await loadCorpusCases(corpusDir)
    const provablyBenign = cases.filter((entry) => entry.category === 'provably-benign')

    const first = provablyBenign[0]
    const keyA = await deriveShellCorpusRuntimeKey(first.command)
    const keyB = await deriveShellCorpusRuntimeKey(first.command)
    expect(keyA).toBe(keyB)
    expect(first.runtimeKey).toBe(keyA)
  })

  it('rejects precomputed runtimeKey that does not match derived fingerprint', async () => {
    await expect(
      enrichProvablyBenignRuntimeKeys([
        {
          kind: 'shell',
          category: 'provably-benign',
          command: 'git status',
          verdict: 'allow',
          runtimeKey: 'wrong-fingerprint',
        },
      ]),
    ).rejects.toThrow(/runtimeKey mismatch/)
  })
})
