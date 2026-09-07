import { describe, expect, it, vi } from 'vitest'
import type { AuditSnapshotActionV2 } from '../core/audit-replay-context.js'
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

  it('replays a v2 Read snapshot with its classifier path input', async () => {
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

    const record: AuditRecord = {
      event: 'preToolUse',
      kind: 'tool',
      verdict: 'deny_pending_approval',
      reason: 'unknown_local_effect',
      summary: 'Read src/index.ts',
      actionSnapshot: {
        schemaVersion: 2,
        kind: 'tool',
        cwd: `${repoRoot}/src`,
        toolName: 'Read',
        action: {
          type: 'file',
          operation: 'read',
          path: 'src/index.ts',
        },
      },
      replayContext: {
        cwd: `${repoRoot}/src`,
        kind: 'tool',
        toolName: 'Read',
      },
    }

    await reclassifyAuditRecord(record, config, repoRoot)

    expect(classifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool',
        cwd: `${repoRoot}/src`,
        toolName: 'Read',
        payload: {
          tool_name: 'Read',
          tool_input: { file_path: 'src/index.ts' },
        },
      }),
      config,
      expect.anything(),
    )
  })

  const toolSnapshotCases: Array<{
    label: string
    toolName: string
    action: AuditSnapshotActionV2
    toolInput: Record<string, unknown>
  }> = [
    {
      label: 'Write',
      toolName: 'Write',
      action: { type: 'file', operation: 'write', path: 'src/index.ts' },
      toolInput: { file_path: 'src/index.ts', contents: '' },
    },
    {
      label: 'Patch',
      toolName: 'ApplyPatch',
      action: {
        type: 'patch',
        targets: [
          { operation: 'update', path: 'src/index.ts' },
          { operation: 'delete', path: 'src/old.ts' },
        ],
      },
      toolInput: {
        patch:
          '*** Begin Patch\n*** Update File: src/index.ts\n*** Delete File: src/old.ts\n*** End Patch',
      },
    },
  ]

  it.each(toolSnapshotCases)('replays a v2 $label snapshot with minimal classifier inputs', async ({
    toolName,
    action,
    toolInput,
  }) => {
    const classifySpy = vi.spyOn(gateEngine, 'classifyGatedAction').mockResolvedValue({
      verdict: 'allow_flagged',
      reason: 'file_mutation',
      summary: toolName,
      fingerprint: 'tool-fp',
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: 'this repository',
        confidence: 1,
        signals: [],
      },
    })

    await reclassifyAuditRecord(
      {
        event: 'preToolUse',
        kind: 'tool',
        verdict: 'allow_flagged',
        reason: 'file_mutation',
        summary: toolName,
        actionSnapshot: {
          schemaVersion: 2,
          kind: 'tool',
          cwd: `${repoRoot}/src`,
          toolName,
          action,
        },
      },
      config,
      repoRoot,
    )

    expect(classifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool',
        cwd: `${repoRoot}/src`,
        toolName,
        payload: { tool_name: toolName, tool_input: toolInput },
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

  it('falls back to repoRoot cwd when replayContext is absent', async () => {
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

    await reclassifyAuditRecord(
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        summary: 'git status',
      },
      config,
      repoRoot,
    )

    expect(classifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'shell',
        cwd: repoRoot,
        command: 'git status',
      }),
      config,
      expect.anything(),
    )
  })

  it('prefers actionSnapshot over summary when payload hash matches', async () => {
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

    await reclassifyAuditRecord(
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        summary: 'stale summary text',
        actionSnapshot: {
          schemaVersion: 1,
          kind: 'shell',
          cwd: `${repoRoot}/src`,
          normalizedAction: 'git status',
        },
      },
      config,
      repoRoot,
    )

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

  it('drops replay payload when actionSnapshot payloadHash mismatches', async () => {
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

    await reclassifyAuditRecord(
      {
        event: 'preToolUse',
        kind: 'tool',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        summary: 'stale summary',
        actionSnapshot: {
          schemaVersion: 1,
          kind: 'tool',
          cwd: `${repoRoot}/src`,
          normalizedAction: 'git status',
          toolName: 'Shell',
          payloadHash: 'deadbeef',
        },
        replayContext: {
          cwd: `${repoRoot}/src`,
          kind: 'tool',
          toolName: 'Shell',
          payload: { tool_name: 'Shell', tool_input: { command: 'rm -rf .git' } },
        },
      },
      config,
      repoRoot,
    )

    expect(classifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool',
        toolName: 'Shell',
        payload: expect.objectContaining({
          tool_name: 'Shell',
          tool_input: { command: 'git status' },
        }),
      }),
      config,
      expect.anything(),
    )
  })
})
