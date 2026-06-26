import { describe, expect, it, vi } from 'vitest'
import type { AuditRecord } from '../core/audit-types.js'
import { mergeConfig } from '../core/config.js'
import * as gateEngine from '../core/gate-engine.js'
import { diffReclassification, reclassifyAuditRecord } from '../core/reclassify.js'

describe('reclassify replay fidelity', () => {
  const repoRoot = '/workspace/project'
  const config = mergeConfig({ mode: 'audit' })

  it('uses preserved replayContext cwd for shell commands', async () => {
    const classifySpy = vi.spyOn(gateEngine, 'classifyGatedAction').mockResolvedValue({
      verdict: 'allow',
      reason: 'read_only',
      summary: 'git status',
      fingerprint: 'fp',
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'none',
        confidence: 1,
        signals: [],
      },
    })

    const record: AuditRecord = {
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      reason: 'unknown_local_effect',
      summary: 'git status',
      replayContext: {
        cwd: `${repoRoot}/src`,
        kind: 'shell',
        command: 'git status',
      },
    }

    await reclassifyAuditRecord(record, config, repoRoot)

    expect(classifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'shell',
        cwd: `${repoRoot}/src`,
        command: 'git status',
      }),
      config,
      expect.anything(),
    )
  })

  it('uses preserved tool replayContext instead of generic Shell fallback', async () => {
    const classifySpy = vi.spyOn(gateEngine, 'classifyGatedAction').mockResolvedValue({
      verdict: 'allow',
      reason: 'read_only',
      summary: 'Read',
      fingerprint: 'tool-fp',
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'none',
        confidence: 1,
        signals: [],
      },
    })

    const payload = { path: 'src/index.ts' }
    const record: AuditRecord = {
      event: 'preToolUse',
      kind: 'tool',
      verdict: 'deny_pending_approval',
      reason: 'unknown_local_effect',
      summary: 'Read',
      replayContext: {
        cwd: `${repoRoot}/src`,
        kind: 'tool',
        toolName: 'Read',
        payload,
      },
    }

    await reclassifyAuditRecord(record, config, repoRoot)

    expect(classifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool',
        cwd: `${repoRoot}/src`,
        toolName: 'Read',
        payload,
      }),
      config,
      expect.anything(),
    )
  })

  it('surfaces replay cwd on simulate diffs', async () => {
    vi.spyOn(gateEngine, 'classifyGatedAction').mockResolvedValue({
      verdict: 'allow',
      reason: 'read_only',
      summary: 'git status',
      fingerprint: 'fp',
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'none',
        confidence: 1,
        signals: [],
      },
    })

    const diff = await diffReclassification(
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        summary: 'git status',
        replayContext: {
          cwd: `${repoRoot}/src`,
          kind: 'shell',
          command: 'git status',
        },
      },
      config,
      repoRoot,
    )

    expect(diff?.replayCwd).toBe(`${repoRoot}/src`)
    expect(diff?.replayKind).toBe('shell')
    expect(diff?.nextVerdict).toBe('allow')
  })
})
