import path from 'node:path'

import { loadApprovalState, loadConfigFile } from '../config-io.js'
import { compactApprovals } from '../core/approval.js'
import type { ExplainOptions, ExplainReport } from '../types.js'
import { classifyForReport } from './classify-for-report.js'

export async function explainCommand(options: ExplainOptions): Promise<ExplainReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())

  if (!options.command && !options.payload && options.explainLastPending !== false) {
    const config = await loadConfigFile(repoRoot)
    const pending = compactApprovals(
      await loadApprovalState(repoRoot, 'pending-approvals.json', config),
    )
    if (pending.approvals.length > 0) {
      const latest = [...pending.approvals].sort(
        (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
      )[0]
      const inputKind =
        latest.inputKind ??
        (latest.kind === 'egress' || latest.kind === 'capability' ? 'shell' : latest.kind)
      const classified = await classifyForReport({
        targetDir: repoRoot,
        cwd: options.cwd,
        kind: inputKind,
        command: latest.input ?? latest.summary,
      })
      return {
        repoRoot: classified.repoRoot,
        kind: classified.kind,
        command: classified.input,
        cwd: classified.cwd,
        policy: classified.policy,
        overrides: classified.overrides,
        egress: classified.egress,
        egressProxyRunning: classified.egressProxyRunning,
        egressL3DemotionActive: false,
        sandbox: classified.sandbox,
        sandboxBrokerActive: classified.sandboxBrokerActive,
        l1FullActive: classified.l1FullActive,
        transactionalEligible: classified.transactionalEligible,
        permission: classified.permission,
        tier: classified.tier,
        approvalId: latest.approvalId,
        result: classified.result,
      }
    }
  }

  if (!options.command && !options.payload) {
    throw new Error('explain requires --command, --payload-json, or a pending approval to explain.')
  }

  const classified = await classifyForReport({
    targetDir: repoRoot,
    cwd: options.cwd,
    kind: options.kind,
    command: options.command,
    toolName: options.toolName,
    payload: options.payload,
  })

  return {
    repoRoot: classified.repoRoot,
    kind: classified.kind,
    command: classified.input,
    cwd: classified.cwd,
    policy: classified.policy,
    overrides: classified.overrides,
    egress: classified.egress,
    egressProxyRunning: classified.egressProxyRunning,
    egressL3DemotionActive: false,
    sandbox: classified.sandbox,
    sandboxBrokerActive: classified.sandboxBrokerActive,
    l1FullActive: classified.l1FullActive,
    transactionalEligible: classified.transactionalEligible,
    permission: classified.permission,
    tier: classified.tier,
    result: classified.result,
  }
}

export function formatExplainReport(report: ExplainReport): string {
  const { result } = report
  const judgeFields = result.v2
    ? [
        result.v2.judgeProvider ? `  judgeProvider: ${result.v2.judgeProvider}` : null,
        result.v2.judgeModelResolved ? `  judgeModel: ${result.v2.judgeModelResolved}` : null,
        result.v2.judgeLatencyMs !== undefined
          ? `  judgeLatencyMs: ${result.v2.judgeLatencyMs}`
          : null,
        result.v2.judgeFallbackReason
          ? `  judgeFallbackReason: ${result.v2.judgeFallbackReason}`
          : null,
      ].filter((line): line is string => line !== null)
    : []

  const lines = [
    `belay explain for ${report.repoRoot}`,
    ...(report.approvalId ? [`Pending approval: ${report.approvalId}`] : []),
    `Kind: ${report.kind}`,
    `Input: ${report.command}`,
    `CWD: ${report.cwd}`,
    `Permission: ${report.permission}`,
    `Tier: ${report.tier}`,
    `Policy unknownLocalEffect: ${report.policy.unknownLocalEffect}`,
    `Egress (partial L1): ${report.egress.enabled ? 'enabled' : 'disabled'} (proxy running=${report.egressProxyRunning}; shell L3 demotion inactive — read/mutate enforced at proxy layer per R36)`,
    report.egress.enabled
      ? `Egress proxy: ${report.egress.listenHost}:${report.egress.listenPort}`
      : 'Egress proxy: not configured',
    `Sandbox (L1 broker): ${report.sandbox.enabled ? 'enabled' : 'disabled'} (runtime=${report.sandbox.runtime}, fs broker active=${report.sandboxBrokerActive}, L1-full=${report.l1FullActive})`,
    `Transactional (L2): ${report.policy.transactional.enabled ? 'enabled' : 'disabled'} (eligible for this command=${report.transactionalEligible})`,
    report.policy.transactional.enabled
      ? `Transactional band: [${report.policy.transactional.minConfidence}, ${report.policy.transactional.maxConfidence})`
      : 'Transactional band: not configured',
    `Overrides allow: ${report.overrides.allow.join(', ') || '(none)'}`,
    `Overrides external: ${report.overrides.external.join(', ') || '(none)'}`,
    '',
    `Verdict: ${result.verdict}`,
    `Reason: ${result.reason}`,
    `Fingerprint: ${result.fingerprint}`,
    ...(result.v2
      ? [
          '',
          'v2 axes:',
          `  location: ${result.v2.location}`,
          `  opacity: ${result.v2.opacity}`,
          `  effect: ${result.v2.effect}`,
          `  confidence: ${result.v2.confidence}`,
          `  would: ${result.v2.would}`,
          ...(judgeFields.length > 0 ? ['judgeTrace:', ...judgeFields] : []),
        ]
      : []),
    '',
    'Predicted assessment:',
    `  reversibility: ${result.assessment.reversibility}`,
    `  external: ${result.assessment.external}`,
    `  blastRadius: ${result.assessment.blastRadius}`,
    `  confidence: ${result.assessment.confidence}`,
    `  signals: ${result.assessment.signals.join(', ') || '(none)'}`,
    report.transactionalEligible
      ? 'Observed assessment: measured in an isolated git worktree at gate time. Observed-safe commands are applied once and the hook denies re-execution (transactional_already_applied).'
      : 'Observed assessment: not applicable (transactional path not eligible).',
  ]
  return `${lines.join('\n')}\n`
}
