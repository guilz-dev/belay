import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1]
    if (typeof callback === 'function') {
      callback(null, 'true', '')
    }
  }),
)

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))

import { formatRecoverReport, recoverProject } from '../commands/recover.js'
import {
  buildRecoverAdvice,
  containsDeniedRecoveryPattern,
  RECOVER_DISCLAIMER,
  SHOW_DONT_RUN_LEAD,
} from '../core/recover-advice.js'
import * as recoverGitProbe from '../core/recover-git-probe.js'
import { isReadOnlyGitProbe } from '../core/recover-git-probe.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

afterEach(async () => {
  execFileMock.mockClear()
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('recover advice (T-R3, T-R4, T-R5)', () => {
  it('marks external irreversible targets as not recoverable (T-R3)', () => {
    const result = buildRecoverAdvice({
      repoRoot: '/repo',
      target: {
        summary: 'docker push myapp:latest',
        reason: 'tier0_external',
        effect: 'external_effect',
        assessment: { reversibility: 'irreversible', external: true } as never,
      },
    })

    expect(result.recoverable).toBe(false)
    expect(result.advice.some((line) => line.includes('not recoverable'))).toBe(true)
  })

  it('does not suggest irreversible recovery patterns (T-R4)', () => {
    const result = buildRecoverAdvice({
      repoRoot: '/repo',
      target: {
        summary: 'rm tracked.txt',
        reason: 'local_mutation',
        effect: 'local_mutation',
      },
      git: { inWorkTree: true, notes: [] },
    })

    const combined = result.advice.join('\n')
    expect(containsDeniedRecoveryPattern(combined)).toBe(false)
    expect(combined).not.toMatch(/reset\s+--hard/i)
  })

  it('does not suggest recovery commands when assessment confidence is below flag threshold', () => {
    const result = buildRecoverAdvice({
      repoRoot: '/repo',
      target: {
        summary: 'rm maybe-tracked.txt',
        reason: 'local_mutation',
        effect: 'local_mutation',
        assessment: {
          reversibility: 'recoverable_with_cost',
          external: false,
          blastRadius: 'repo',
          confidence: 0.5,
          signals: [],
        },
      },
      git: { inWorkTree: true, notes: [] },
      minAssessmentConfidence: 0.72,
    })

    expect(result.recoverable).toBe(false)
    expect(result.advice.some((line) => line.includes('git restore'))).toBe(false)
    expect(result.warnings.some((line) => line.includes('Low confidence'))).toBe(true)
  })

  it('includes show-don-t-run disclaimer framing (T-R5)', () => {
    const result = buildRecoverAdvice({
      repoRoot: '/repo',
      target: {
        summary: 'rm file.txt',
        reason: 'local_mutation',
        effect: 'local_mutation',
      },
      git: { inWorkTree: true, notes: [] },
    })

    expect(RECOVER_DISCLAIMER.every((line) => result.disclaimer.includes(line))).toBe(true)
    expect(
      formatRecoverReport({
        repoRoot: '/repo',
        recoverable: result.recoverable,
        confidence: result.confidence,
        disclaimer: result.disclaimer,
        advice: result.advice,
        warnings: result.warnings,
      }),
    ).toContain('Advisory only')
  })
})

describe('recoverProject integration (T-R1, T-R2)', () => {
  it('T-R1: reads audit NDJSON and suggests git restore for local mutation', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-recover-'))
    tempDirs.push(tempDir)
    await initProject({ targetDir: tempDir })

    const auditRecord = {
      timestamp: '2026-06-01T12:00:00.000Z',
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      reason: 'unknown_local_effect',
      effect: 'local_mutation',
      location: 'repo',
      summary: 'rm src/important.ts',
      fingerprint: 'fp-recover-local',
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: 'repo',
        confidence: 0.75,
        signals: [],
      },
    }

    await writeFile(
      path.join(tempDir, '.cursor', 'belay', 'audit.ndjson'),
      `${JSON.stringify(auditRecord)}\n`,
      'utf8',
    )

    vi.spyOn(recoverGitProbe, 'probeGitState').mockResolvedValue({
      inWorkTree: true,
      porcelain: ' M src/important.ts',
      notes: [],
    })

    const report = await recoverProject({
      targetDir: tempDir,
      fingerprint: 'fp-recover-local',
    })

    expect(report.recoverable).toBe(true)
    expect(report.advice.some((line) => line.includes('git restore'))).toBe(true)
    expect(report.advice[0]).toBe(SHOW_DONT_RUN_LEAD)
    expect(report.target?.summary).toBe('rm src/important.ts')
  })

  it('T-R2: recoverProject only invokes read-only git probes', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-recover-exec-'))
    tempDirs.push(tempDir)
    await initProject({ targetDir: tempDir })

    await writeFile(
      path.join(tempDir, '.cursor', 'belay', 'audit.ndjson'),
      `${JSON.stringify({
        timestamp: '2026-06-01T12:00:00.000Z',
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        reason: 'unknown_local_effect',
        effect: 'local_mutation',
        summary: 'rm tracked.txt',
        fingerprint: 'fp-recover-exec',
      })}\n`,
      'utf8',
    )

    await recoverProject({ targetDir: tempDir, fingerprint: 'fp-recover-exec' })

    const gitCalls = execFileMock.mock.calls.filter((call) => call[0] === 'git')
    expect(gitCalls.length).toBeGreaterThan(0)
    for (const call of gitCalls) {
      const args = call[1] as string[]
      expect(isReadOnlyGitProbe(args.join(' '))).toBe(true)
    }
    expect(execFileMock.mock.calls.every((call) => call[0] === 'git')).toBe(true)
  })

  it('warns when --command may invoke Tier1 classification', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-recover-cmd-'))
    tempDirs.push(tempDir)
    await initProject({ targetDir: tempDir })

    const report = await recoverProject({
      targetDir: tempDir,
      command: 'git status',
    })

    expect(
      report.warnings.some((line) => line.includes('Tier1 judge') || line.includes('Tier1')),
    ).toBe(true)
  })

  it('prefers allow(local_mutation) over ask(external) when auto-selecting', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-recover-priority-'))
    tempDirs.push(tempDir)
    await initProject({ targetDir: tempDir })

    const externalAsk = {
      timestamp: '2026-06-02T12:00:00.000Z',
      event: 'beforeShellExecution',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      reason: 'tier0_external',
      effect: 'external_effect',
      summary: 'docker push myapp:latest',
      fingerprint: 'fp-recover-external-newer',
    }
    const localAllow = {
      timestamp: '2026-06-01T12:00:00.000Z',
      event: 'beforeShellExecution',
      verdict: 'allow',
      permission: 'allow',
      reason: 'local_mutation',
      effect: 'local_mutation',
      summary: 'rm src/important.ts',
      fingerprint: 'fp-recover-local-older',
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: 'repo',
        confidence: 0.75,
        signals: [],
      },
    }

    await writeFile(
      path.join(tempDir, '.cursor', 'belay', 'audit.ndjson'),
      `${JSON.stringify(externalAsk)}\n${JSON.stringify(localAllow)}\n`,
      'utf8',
    )

    vi.spyOn(recoverGitProbe, 'probeGitState').mockResolvedValue({
      inWorkTree: true,
      porcelain: ' M src/important.ts',
      notes: [],
    })

    const report = await recoverProject({ targetDir: tempDir })

    expect(report.target?.fingerprint).toBe('fp-recover-local-older')
    expect(report.recoverable).toBe(true)
    expect(report.advice.some((line) => line.includes('git restore'))).toBe(true)
  })

  it('prefers blocked local_mutation over ask(external) when auto-selecting', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-recover-blocked-local-'))
    tempDirs.push(tempDir)
    await initProject({ targetDir: tempDir })

    const externalAsk = {
      timestamp: '2026-06-03T12:00:00.000Z',
      event: 'beforeShellExecution',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      reason: 'tier0_external',
      effect: 'external_effect',
      summary: 'docker push myapp:latest',
      fingerprint: 'fp-recover-external-newer-2',
    }
    const blockedLocal = {
      timestamp: '2026-06-02T12:00:00.000Z',
      event: 'beforeShellExecution',
      verdict: 'deny_pending_approval',
      wouldBlock: true,
      reason: 'unknown_local_effect',
      effect: 'local_mutation',
      summary: 'rm src/older.ts',
      fingerprint: 'fp-recover-blocked-local',
    }

    await writeFile(
      path.join(tempDir, '.cursor', 'belay', 'audit.ndjson'),
      `${JSON.stringify(externalAsk)}\n${JSON.stringify(blockedLocal)}\n`,
      'utf8',
    )

    vi.spyOn(recoverGitProbe, 'probeGitState').mockResolvedValue({
      inWorkTree: true,
      porcelain: ' D src/older.ts',
      notes: [],
    })

    const report = await recoverProject({ targetDir: tempDir })

    expect(report.target?.fingerprint).toBe('fp-recover-blocked-local')
    expect(report.advice.some((line) => line.includes('git restore'))).toBe(true)
  })

  it('T-R3: audit external_effect entry is not recoverable', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-recover-ext-'))
    tempDirs.push(tempDir)
    await initProject({ targetDir: tempDir })

    await writeFile(
      path.join(tempDir, '.cursor', 'belay', 'audit.ndjson'),
      `${JSON.stringify({
        timestamp: '2026-06-01T12:00:00.000Z',
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        reason: 'tier0_external',
        effect: 'external_effect',
        summary: 'docker push myapp:latest',
        fingerprint: 'fp-recover-external',
      })}\n`,
      'utf8',
    )

    const report = await recoverProject({
      targetDir: tempDir,
      fingerprint: 'fp-recover-external',
    })

    expect(report.recoverable).toBe(false)
    expect(report.advice.some((line) => line.includes('not recoverable'))).toBe(true)
  })
})
