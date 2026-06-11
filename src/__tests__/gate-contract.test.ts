import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cursorLayout } from '../adapters/layouts/cursor.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../adapters/shared/gate-runtime.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import {
  classifyResultToGateVerdict,
  GATE_CONTRACT_VERSION,
  unnormalizedGateVerdict,
} from '../core/gate-contract.js'
import {
  classifyGatedAction,
  extractAgentAssessment,
  GateNormalizationError,
  normalizeGatedAction,
} from '../core/gate-engine.js'

describe('gate contract', () => {
  it('normalizes shell actions with contract version', () => {
    const action = normalizeGatedAction({
      kind: 'shell',
      repoRoot: '/repo',
      cwd: '/repo',
      command: 'git status',
    })
    expect(action.contractVersion).toBe(GATE_CONTRACT_VERSION)
    expect(action.kind).toBe('shell')
    expect(action.command).toBe('git status')
  })

  it('fails closed when shell command is missing', () => {
    expect(() =>
      normalizeGatedAction({
        kind: 'shell',
        repoRoot: '/repo',
        cwd: '/repo',
      }),
    ).toThrow(GateNormalizationError)
  })

  it('classifies normalized shell actions', () => {
    const action = normalizeGatedAction({
      kind: 'shell',
      repoRoot: '/repo',
      cwd: '/repo',
      command: 'git status',
    })
    const result = classifyGatedAction(action, DEFAULT_CONFIG_V3)
    expect(result.verdict).toBe('allow')
  })

  it('extracts agent assessment from hook payloads', () => {
    const assessment = extractAgentAssessment({
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'none',
        confidence: 0.99,
        signals: ['agent_claim'],
      },
    })
    expect(assessment?.confidence).toBe(0.99)
  })

  it('escalates when agent assessment mismatches independent judgment', () => {
    const action = normalizeGatedAction({
      kind: 'shell',
      repoRoot: '/repo',
      cwd: '/repo',
      command: 'git push origin main',
      agentAssessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'none',
        confidence: 0.99,
        signals: [],
      },
    })
    const result = classifyGatedAction(action, DEFAULT_CONFIG_V3)
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.reason).toBe('agent_assessment_mismatch')
  })

  it('maps unnormalized actions to deny verdicts', () => {
    const verdict = unnormalizedGateVerdict({
      reason: 'normalization_failed',
      mode: 'enforce',
      user_message: 'blocked',
    })
    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe('normalization_failed')
  })

  it('evaluates gated actions through shared runtime deps', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-gate-contract-'))
    const ctx = {
      layout: cursorLayout,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG_V3,
        audit: { ...DEFAULT_CONFIG_V3.audit, logPath: '.cursor/belay/audit.ndjson' },
      },
      configPath: path.join(repoRoot, '.cursor', 'belay.config.json'),
    }
    const deps = createDefaultGateRuntimeDeps()
    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: '/repo',
      command: '',
    })
    expect(verdict.permission).toBe('deny')
    expect(verdict.reason).toBe('normalization_failed')
  })

  it('maps classify results to gate verdicts', () => {
    const verdict = classifyResultToGateVerdict({
      result: {
        verdict: 'allow',
        reason: 'read_only',
        fingerprint: 'fp',
        assessment: {
          reversibility: 'reversible',
          external: false,
          blastRadius: 'none',
          confidence: 1,
          signals: [],
        },
      },
      mode: 'enforce',
      permission: 'allow',
      wouldBlock: false,
    })
    expect(verdict.contractVersion).toBe(GATE_CONTRACT_VERSION)
    expect(verdict.permission).toBe('allow')
  })
})
