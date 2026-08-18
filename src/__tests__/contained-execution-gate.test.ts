import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorLayout } from '../adapters/layouts/cursor.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
  type GateRuntimeContext,
  type GateRuntimeDeps,
  gateVerdictToClaudePreToolUseResponse,
  gateVerdictToCodexPreToolUseResponse,
  gateVerdictToCursorResponse,
} from '../adapters/shared/gate-runtime.js'
import { auditProject } from '../commands/audit.js'
import { formatExplainReport } from '../commands/explain.js'
import { formatMetricsReport, metricsProject } from '../commands/metrics.js'
import { computeAuditMetrics } from '../core/audit-metrics.js'
import { type BelayConfigV3, mergeConfig } from '../core/config.js'
import {
  ContainedDockerBoundaryUnavailableError,
  ContainedDockerCleanupUnconfirmedError,
  ContainedDockerStartAttemptError,
  type ExecuteContainedDockerParams,
} from '../core/contained-execution/docker.js'
import type { ContainedExecutionMirrorOptions } from '../core/contained-execution/mirror.js'
import {
  ContainedExecutionCleanupUnconfirmedError,
  withContainedExecutionMirror,
} from '../core/contained-execution/mirror.js'
import type { GateVerdict } from '../core/gate-contract.js'
import * as gateEngine from '../core/gate-engine.js'
import type { ClassifyResult } from '../core/types.js'
import { classifyShellCore } from './helpers/shell-classify.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(mode: 'enforce' | 'audit' = 'enforce') {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-gate-'))
  roots.push(repoRoot)
  await mkdir(path.join(repoRoot, 'app'), { recursive: true })
  await writeFile(path.join(repoRoot, 'input.txt'), 'source remains unchanged\n')
  const controlPlaneDir = path.join(repoRoot, '.belay-control')
  await mkdir(controlPlaneDir)
  const config = mergeConfig({
    mode,
    controlPlane: { enabled: true, configDir: controlPlaneDir, integrity: 'hash-pinned' },
    policy: {
      unknownLocalEffect: 'deny',
      transactional: {
        enabled: false,
        fileCheckpoint: {
          enabled: false,
          allowNonGit: true,
          maxFiles: 321,
          maxSourceBytes: 654_321,
          maxWorkspaceBytes: 765_432,
          prepareTimeoutMs: 4_321,
          copyConcurrency: 2,
        },
      },
    },
    sandbox: {
      enabled: true,
      runtime: 'container',
      denyNetworkByDefault: true,
      containedExecution: {
        enabled: true,
        image: 'registry.example/contained-runner:latest',
        dockerExecutable: '/opt/docker/bin/docker',
        dockerHost: 'unix:///var/run/docker.sock',
        timeoutMs: 30_000,
        memoryMiB: 2048,
        cpus: 2,
        pids: 256,
      },
    },
  })
  const ctx: GateRuntimeContext = {
    layout: cursorLayout,
    repoRoot,
    config,
    configPath: path.join(repoRoot, '.cursor', 'belay.config.json'),
  }
  await mkdir(path.dirname(ctx.configPath), { recursive: true })
  await writeFile(ctx.configPath, `${JSON.stringify(config, null, 2)}\n`)
  return { repoRoot, controlPlaneDir, config, ctx }
}

async function eligibleResult(command: string, repoRoot: string): Promise<ClassifyResult> {
  const result = await classifyShellCore(command, path.join(repoRoot, 'app'), repoRoot)
  expect(result.reason).toBe('unknown_local_effect')
  return result
}

function patchedDeps(params: {
  auditEvents: Record<string, unknown>[]
  onMirror?: GateRuntimeDeps['withContainedExecutionMirror']
  onExecute?: GateRuntimeDeps['executeContainedDocker']
  onReplay?: GateRuntimeDeps['replayApprovedShell']
  onReadAttestation?: GateRuntimeDeps['readSignedAttestation']
  persistAudit?: boolean
}): GateRuntimeDeps {
  const base = createDefaultGateRuntimeDeps()
  const approvalStates = new Map<string, { version: 3; approvals: never[] }>()
  return {
    ...base,
    appendAudit: async (_ctx, event) => {
      params.auditEvents.push(event)
      if (params.persistAudit) {
        await base.appendAudit(_ctx, event)
      }
    },
    loadApprovals: async (_ctx, fileName) => {
      const filePath = `/tmp/${fileName}`
      return {
        filePath,
        state: approvalStates.get(filePath) ?? { version: 3, approvals: [] },
      }
    },
    writeApprovals: async (filePath, state) => {
      approvalStates.set(filePath, state as { version: 3; approvals: never[] })
    },
    readSignedAttestation: params.onReadAttestation ?? (async () => ({ signed: true })),
    withContainedExecutionMirror: params.onMirror ?? withContainedExecutionMirror,
    executeContainedDocker:
      params.onExecute ??
      (async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        executionStarted: true,
        receipt: { imageId: `sha256:${'a'.repeat(64)}` } as never,
        receiptHash: 'receipt-hash',
      })),
    replayApprovedShell:
      params.onReplay ??
      (async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '' })),
  }
}

describe('contained unknown execution gate integration', () => {
  it('marks audit-mode eligibility without preparing a mirror or starting Docker', async () => {
    const { repoRoot, ctx } = await fixture('audit')
    const result = await eligibleResult('fictional-runner verify', repoRoot)
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue(result)
    const auditEvents: Record<string, unknown>[] = []
    const deps = patchedDeps({
      auditEvents,
      persistAudit: true,
      onMirror: async () => {
        throw new Error('audit mode prepared a mirror')
      },
      onExecute: async () => {
        throw new Error('audit mode called Docker')
      },
    })

    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: path.join(repoRoot, 'app'),
      command: 'fictional-runner verify',
    })

    expect(verdict).toMatchObject({ permission: 'allow', wouldBlock: true, wouldMediate: true })
    expect(verdict.approvalId).toBeUndefined()
    expect(auditEvents).toHaveLength(1)
    expect(auditEvents[0]).toMatchObject({ wouldMediate: true, permission: 'allow' })
    const raw = await readFile(path.join(repoRoot, ctx.config.audit.logPath), 'utf8')
    expect(raw).toContain('"wouldMediate":true')
    expect(raw).not.toContain('fictional-runner verify')
    expect(raw).not.toContain(repoRoot)
    expect((await metricsProject({ targetDir: repoRoot })).containedExecution.wouldMediate).toBe(1)
  })

  it.each([
    ['fictional-runner verify', 0, false, 'contained_execution_complete'],
    ["bin/rails runner 'Record.count'", 7, false, 'contained_execution_failed'],
    ['bundle exec rspec --dry-run', null, true, 'contained_execution_failed'],
  ] as const)('mediates %s once, blocks host execution, and reports %s', async (command, exitCode, timedOut, reason) => {
    const { repoRoot, controlPlaneDir, config, ctx } = await fixture()
    const result = await eligibleResult(command, repoRoot)
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue(result)
    const auditEvents: Record<string, unknown>[] = []
    const executions: ExecuteContainedDockerParams[] = []
    const mirrorOptions: ContainedExecutionMirrorOptions[] = []
    const attestationPaths: string[] = []
    let hostExecutions = 0
    const deps = patchedDeps({
      auditEvents,
      onReadAttestation: async (filePath) => {
        attestationPaths.push(filePath)
        return { signed: true }
      },
      onMirror: async (options, operation) => {
        mirrorOptions.push(options)
        return withContainedExecutionMirror(options, operation)
      },
      onExecute: async (params) => {
        executions.push(params)
        await writeFile(path.join(params.mirror.hostMirrorRoot, 'guest-only.txt'), 'discard me')
        return {
          exitCode,
          signal: timedOut ? 'SIGKILL' : null,
          timedOut,
          stdout: 'guest stdout',
          stderr: 'guest stderr',
          stdoutTruncated: false,
          stderrTruncated: false,
          executionStarted: true,
          receipt: { imageId: `sha256:${'a'.repeat(64)}` } as never,
          receiptHash: `receipt-${exitCode}`,
        }
      },
      onReplay: async () => {
        hostExecutions += 1
        return { exitCode: 0, signal: null, timedOut: false }
      },
    })

    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: path.join(repoRoot, 'app'),
      command,
    })

    expect(executions).toHaveLength(1)
    expect(hostExecutions).toBe(0)
    expect(attestationPaths).toEqual([path.join(repoRoot, '.belay', 'attestation.json')])
    expect(mirrorOptions).toEqual([
      expect.objectContaining({
        sourceRoot: repoRoot,
        limits: {
          maxFiles: 321,
          maxSourceBytes: 654_321,
          maxWorkspaceBytes: 765_432,
          prepareTimeoutMs: 4_321,
        },
      }),
    ])
    expect(executions[0]).toMatchObject({
      repoRoot,
      controlPlaneDir,
      config: config.sandbox.containedExecution,
      guestCwd: path.join(repoRoot, 'app'),
      command,
      inputFingerprint: result.fingerprint,
      signedAttestation: { signed: true },
    })
    expect(executions[0]?.mirror.guestWorkspacePath).toBe(repoRoot)
    expect(executions[0]?.protectedRoots).toEqual(
      expect.arrayContaining([
        controlPlaneDir,
        path.join(repoRoot, '.belay', 'attestation.json'),
        cursorLayout.configPath(repoRoot),
        cursorLayout.hooksDir(repoRoot),
        cursorLayout.runtimeDir(repoRoot),
        cursorLayout.repoLocalStateDir(repoRoot),
      ]),
    )
    expect(verdict).toMatchObject({
      permission: 'deny',
      wouldBlock: false,
      reason,
      mediatedExecution: {
        exitCode,
        timedOut,
        workspaceChangesDiscarded: true,
      },
    })
    expect(verdict.approvalId).toBeUndefined()
    expect(auditEvents[0]).toMatchObject({
      reason,
      permission: 'deny',
      receiptHash: `receipt-${exitCode}`,
      imageId: `sha256:${'a'.repeat(64)}`,
      mirrorBackend: 'file_copy',
      exitCode,
      timedOut,
    })
    expect(auditEvents[0]?.workspaceChangesDiscarded).toBeUndefined()
    expect(JSON.stringify(auditEvents[0])).not.toContain(command)
    await expect(access(path.join(repoRoot, 'guest-only.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('scrubs and byte-caps adapter-facing output without persisting it to audit', async () => {
    const { repoRoot, ctx } = await fixture()
    const command = 'fictional-runner verify'
    const result = await eligibleResult(command, repoRoot)
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue(result)
    const auditEvents: Record<string, unknown>[] = []
    const secret = 'Authorization: Bearer supersecret.token.value'
    const oversized = `${'x'.repeat(20_000)} ${secret}`
    const deps = patchedDeps({
      auditEvents,
      onExecute: async () => ({
        exitCode: 9,
        signal: null,
        timedOut: false,
        stdout: oversized,
        stderr: `API_KEY=top-secret-value ${oversized}`,
        stdoutTruncated: false,
        stderrTruncated: false,
        executionStarted: true,
        receipt: { imageId: `sha256:${'b'.repeat(64)}` } as never,
        receiptHash: 'private-receipt',
      }),
    })

    const verdict = await evaluateGatedAction(ctx, deps, {
      kind: 'shell',
      cwd: path.join(repoRoot, 'app'),
      command,
    })

    expect(Buffer.byteLength(verdict.mediatedExecution?.stdout ?? '')).toBeLessThanOrEqual(16_384)
    expect(Buffer.byteLength(verdict.mediatedExecution?.stderr ?? '')).toBeLessThanOrEqual(16_384)
    expect(verdict.mediatedExecution).toMatchObject({
      stdoutTruncated: true,
      stderrTruncated: true,
      receiptHash: 'private-receipt',
    })
    expect(verdict.user_message).toContain('Authorization: <redacted>')
    expect(verdict.user_message).toContain('(truncated)')
    expect(verdict.user_message).not.toContain('supersecret.token.value')
    const persisted = JSON.stringify(auditEvents[0])
    expect(persisted).not.toContain('stdout')
    expect(persisted).not.toContain('stderr')
    expect(persisted).not.toContain('supersecret')
    expect(persisted).not.toContain(repoRoot)
  })

  it.each([
    [
      'definite daemon unavailability',
      new ContainedDockerBoundaryUnavailableError('contained_execution_docker_daemon_unavailable'),
      true,
    ],
    [
      'definite substrate unavailability',
      new ContainedDockerBoundaryUnavailableError(
        'contained_execution_docker_substrate_unavailable',
      ),
      true,
    ],
    [
      'missing image',
      new ContainedDockerBoundaryUnavailableError('contained_execution_image_missing'),
      false,
    ],
    ['attempted start', new ContainedDockerStartAttemptError(), false],
    ['container cleanup', new ContainedDockerCleanupUnconfirmedError('container', true), false],
    ['stale attestation', new Error('contained_execution_capability_invalid'), false],
    ['image mismatch', new Error('contained_execution_image_mismatch'), false],
    ['invalid mirror lease', new Error('contained_execution_invalid_mirror_lease'), false],
    [
      'container create failure',
      new ContainedDockerBoundaryUnavailableError('contained_execution_create_failed'),
      true,
    ],
    [
      'container inspect failure',
      new ContainedDockerBoundaryUnavailableError('contained_execution_inspect_failed'),
      true,
    ],
    ['invalid contained config', new Error('contained_execution_resource_limits_invalid'), false],
  ] as const)('%s follows the required approval fallback taxonomy', async (_name, failure, fallback) => {
    const { repoRoot, ctx } = await fixture()
    const result = await eligibleResult('fictional-runner verify', repoRoot)
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue(result)
    const auditEvents: Record<string, unknown>[] = []
    const verdict = await evaluateGatedAction(
      ctx,
      patchedDeps({
        auditEvents,
        onExecute: async () => {
          throw failure
        },
      }),
      { kind: 'shell', cwd: path.join(repoRoot, 'app'), command: 'fictional-runner verify' },
    )

    expect(Boolean(verdict.approvalId)).toBe(fallback)
    expect(verdict.permission).toBe('deny')
    if (!fallback && /capability|image/.test(String((failure as Error).message))) {
      expect(verdict.user_message).toContain('belay session start')
    }
    if (!fallback) {
      expect(auditEvents[0]?.approvalId).toBeUndefined()
    }
  })

  it('fails closed without approval when mirror setup is unavailable', async () => {
    const { repoRoot, ctx } = await fixture()
    const result = await eligibleResult('fictional-runner verify', repoRoot)
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue(result)
    const auditEvents: Record<string, unknown>[] = []
    const verdict = await evaluateGatedAction(
      ctx,
      patchedDeps({
        auditEvents,
        onMirror: async () => {
          throw new Error('contained_execution_mirror_limits_invalid')
        },
      }),
      { kind: 'shell', cwd: path.join(repoRoot, 'app'), command: 'fictional-runner verify' },
    )

    expect(verdict).toMatchObject({
      permission: 'deny',
      reason: 'contained_execution_mirror_limits_invalid',
    })
    expect(verdict.approvalId).toBeUndefined()
  })

  it('fails closed before mirror setup when the signed attestation is unavailable', async () => {
    const { repoRoot, ctx } = await fixture()
    const result = await eligibleResult('fictional-runner verify', repoRoot)
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue(result)
    const auditEvents: Record<string, unknown>[] = []
    let mirrorCalls = 0
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const verdict = await evaluateGatedAction(
      ctx,
      patchedDeps({
        auditEvents,
        onReadAttestation: async () => {
          throw missing
        },
        onMirror: async () => {
          mirrorCalls += 1
          throw new Error('unexpected mirror')
        },
      }),
      { kind: 'shell', cwd: path.join(repoRoot, 'app'), command: 'fictional-runner verify' },
    )

    expect(mirrorCalls).toBe(0)
    expect(verdict).toMatchObject({
      permission: 'deny',
      reason: 'contained_execution_capability_invalid',
    })
    expect(verdict.approvalId).toBeUndefined()
    expect(verdict.user_message).toContain('belay session start')
  })

  it('makes mirror cleanup uncertainty dominant after a completed execution', async () => {
    const { repoRoot, ctx } = await fixture()
    const result = await eligibleResult('fictional-runner verify', repoRoot)
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue(result)
    const auditEvents: Record<string, unknown>[] = []
    const verdict = await evaluateGatedAction(
      ctx,
      patchedDeps({
        auditEvents,
        onMirror: async (options, operation) => {
          await withContainedExecutionMirror(options, operation)
          throw new ContainedExecutionCleanupUnconfirmedError('/private/mirror')
        },
      }),
      { kind: 'shell', cwd: path.join(repoRoot, 'app'), command: 'fictional-runner verify' },
    )

    expect(verdict).toMatchObject({
      permission: 'deny',
      reason: 'contained_execution_cleanup_unconfirmed',
    })
    expect(verdict.approvalId).toBeUndefined()
    expect(auditEvents[0]?.workspaceChangesDiscarded).toBeUndefined()
  })

  it('persists only receipt metadata through audit writer, query, and metrics readers', async () => {
    const { repoRoot, ctx } = await fixture()
    const command = 'fictional-runner verify'
    const result = await eligibleResult(command, repoRoot)
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue(result)
    const auditEvents: Record<string, unknown>[] = []
    await evaluateGatedAction(
      ctx,
      patchedDeps({
        auditEvents,
        persistAudit: true,
        onExecute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: 'Authorization: Bearer never-persist-this-secret',
          stderr: `private path ${repoRoot}`,
          stdoutTruncated: false,
          stderrTruncated: false,
          executionStarted: true,
          receipt: { imageId: `sha256:${'c'.repeat(64)}` } as never,
          receiptHash: 'e'.repeat(64),
        }),
      }),
      { kind: 'shell', cwd: path.join(repoRoot, 'app'), command },
    )

    const raw = await readFile(path.join(repoRoot, ctx.config.audit.logPath), 'utf8')
    expect(raw).toContain('e'.repeat(64))
    expect(raw).not.toContain(command)
    expect(raw).not.toContain('never-persist-this-secret')
    expect(raw).not.toContain(repoRoot)
    expect(raw).not.toContain('stdout')
    expect(raw).not.toContain('stderr')
    const queried = await auditProject({ targetDir: repoRoot, subcommand: 'query' })
    expect(queried.records).toHaveLength(1)
    expect(queried.records?.[0]).toMatchObject({
      receiptHash: 'e'.repeat(64),
      imageId: `sha256:${'c'.repeat(64)}`,
      mirrorBackend: 'file_copy',
      exitCode: 0,
      timedOut: false,
    })
    expect(queried.records?.[0]?.workspaceChangesDiscarded).toBeUndefined()
    expect((await metricsProject({ targetDir: repoRoot })).containedExecution.complete).toBe(1)
  })

  it('mediates a shell command normalized from a tool payload', async () => {
    const { repoRoot, ctx } = await fixture()
    const command = 'fictional-runner verify'
    const result = await eligibleResult(command, repoRoot)
    vi.spyOn(gateEngine, 'classifyGatedActionAsync').mockResolvedValue(result)
    const executions: ExecuteContainedDockerParams[] = []
    const verdict = await evaluateGatedAction(
      ctx,
      patchedDeps({
        auditEvents: [],
        onExecute: async (params) => {
          executions.push(params)
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            executionStarted: true,
            receipt: { imageId: `sha256:${'d'.repeat(64)}` } as never,
            receiptHash: 'payload-receipt',
          }
        },
      }),
      {
        kind: 'shell',
        cwd: path.join(repoRoot, 'app'),
        payload: { tool_name: 'Shell', tool_input: { command } },
        toolName: 'Shell',
      },
    )

    expect(executions).toHaveLength(1)
    expect(executions[0]?.command).toBe(command)
    expect(verdict).toMatchObject({ permission: 'deny', reason: 'contained_execution_complete' })
  })

  it('surfaces would-mediate in metrics and explain output', () => {
    const records = [
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        permission: 'allow',
        wouldBlock: true,
        wouldMediate: true,
      },
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        reason: 'contained_execution_complete',
        permission: 'deny',
        wouldBlock: false,
        receiptHash: 'receipt',
        imageId: `sha256:${'a'.repeat(64)}`,
        mirrorBackend: 'file_copy',
        exitCode: 0,
        timedOut: false,
      },
    ]
    const metrics = computeAuditMetrics(records)
    expect(metrics.containedExecution).toEqual({
      wouldMediate: 1,
      complete: 1,
      failed: 0,
      timedOut: 0,
    })
    expect(formatMetricsReport(metrics)).toContain('Contained execution: would mediate 1')

    const result = records[0] as unknown as ClassifyResult
    expect(
      formatExplainReport({
        repoRoot: '/repo',
        kind: 'shell',
        command: 'fictional-runner verify',
        cwd: '/repo',
        policy: mergeConfig({}).policy,
        overrides: { allow: [], external: [] },
        egress: { enabled: false } as BelayConfigV3['egress'],
        egressProxyRunning: false,
        egressL3DemotionActive: false,
        sandbox: mergeConfig({}).sandbox,
        sandboxBrokerActive: false,
        l1FullActive: false,
        transactionalEligible: false,
        permission: 'ask',
        tier: 'Tier1',
        result: {
          ...result,
          fingerprint: 'fingerprint',
          wouldMediate: true,
          assessment: {
            reversibility: 'reversible',
            external: false,
            blastRadius: 'repo-local',
            confidence: 0.5,
            signals: [],
          },
        },
      }),
    ).toContain('Contained unknown execution: would mediate')
  })

  it('maps mediated completion to host-blocking responses for every adapter', () => {
    const verdict: GateVerdict = {
      contractVersion: 1,
      verdict: 'allow',
      reason: 'contained_execution_complete',
      fingerprint: 'fingerprint',
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'none',
        confidence: 1,
        signals: [],
      },
      permission: 'deny',
      wouldBlock: false,
      mode: 'enforce',
      user_message: 'Contained execution completed; do not run on the host.',
    }

    expect(gateVerdictToCursorResponse(verdict)).toMatchObject({ permission: 'deny' })
    expect(gateVerdictToClaudePreToolUseResponse(verdict)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    })
    expect(gateVerdictToCodexPreToolUseResponse(verdict)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    })
  })
})
