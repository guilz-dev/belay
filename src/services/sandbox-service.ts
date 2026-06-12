import path from 'node:path'

import { loadConfigFile, repoLocalStateDirFor } from '../config-io.js'
import { fsScopeAllowlistPath, loadFsScopeAllowlist } from '../core/capability/allowlist.js'
import {
  evaluateL1FullStatus,
  isCapabilityBrokerDemotionActive,
} from '../core/capability/broker.js'
import { configuredControlPlaneDir } from '../core/config.js'
import { verifyControlPlaneIsolation } from '../core/control-plane-isolation.js'
import { egressStatus } from './egress-service.js'

export interface SandboxServiceOptions {
  targetDir?: string
}

export interface SandboxStatusReport {
  repoRoot: string
  sandboxEnabled: boolean
  sandboxRuntime: string
  denyNetworkByDefault: boolean
  brokerActive: boolean
  fsScopeAllowlistCount: number
  controlPlaneIsolationMode: string
  controlPlaneIsolationOk: boolean
  l1FullActive: boolean
  l1Full: {
    sandbox: boolean
    egress: boolean
    egressProxyRunning: boolean
    controlPlaneIsolation: boolean
    approvalSigningRequired: boolean
  }
  issues: string[]
}

export async function sandboxStatus(
  options: SandboxServiceOptions = {},
): Promise<SandboxStatusReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const repoLocalStateDir = repoLocalStateDirFor(repoRoot, config)
  const allowlistPath = fsScopeAllowlistPath(config, repoLocalStateDir)
  const allowlist = await loadFsScopeAllowlist(allowlistPath)
  const egress = await egressStatus({ targetDir: repoRoot })
  const isolation = verifyControlPlaneIsolation(
    configuredControlPlaneDir(config),
    config.controlPlane.isolation,
  )
  const l1Full = evaluateL1FullStatus({
    config,
    egressProxyRunning: egress.running && !egress.foreignProxy && !egress.repoRootMismatch,
  })

  const issues: string[] = [...isolation.issues]
  if (config.sandbox.enabled && config.sandbox.runtime === 'none') {
    issues.push('sandbox.enabled is true but sandbox.runtime is none')
  }
  if (l1Full.sandbox && l1Full.egress && !l1Full.egressProxyRunning) {
    issues.push('L1-full requires a running egress proxy for this repository')
  }
  if (l1Full.sandbox && !l1Full.controlPlaneIsolation) {
    issues.push('L1-full requires controlPlane.isolation mode other than none')
  }
  if (l1Full.sandbox && !l1Full.approvalSigningRequired) {
    issues.push('L1-full requires approvalSigning.required=true')
  }

  return {
    repoRoot,
    sandboxEnabled: config.sandbox.enabled,
    sandboxRuntime: config.sandbox.runtime,
    denyNetworkByDefault: config.sandbox.denyNetworkByDefault,
    brokerActive: isCapabilityBrokerDemotionActive(config),
    fsScopeAllowlistCount: allowlist.paths.length,
    controlPlaneIsolationMode: config.controlPlane.isolation.mode,
    controlPlaneIsolationOk: isolation.ok,
    l1FullActive: l1Full.active,
    l1Full,
    issues,
  }
}

export function createCapabilityApprovalStore(
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfigFile>>,
) {
  const repoLocalDir = repoLocalStateDirFor(repoRoot, config)
  return {
    allowlistPath: fsScopeAllowlistPath(config, repoLocalDir),
    async loadPending() {
      const { loadApprovalState, pendingApprovalsPath } = await import('../config-io.js')
      const filePath = pendingApprovalsPath(repoRoot, config)
      return {
        filePath,
        state: await loadApprovalState(repoRoot, 'pending-approvals.json', config),
      }
    },
    async loadApproved() {
      const { loadApprovalState, approvedApprovalsPath } = await import('../config-io.js')
      const filePath = approvedApprovalsPath(repoRoot, config)
      return {
        filePath,
        state: await loadApprovalState(repoRoot, 'approved-approvals.json', config),
      }
    },
    async writePending(_filePath: string, state: import('../core/types.js').ApprovalStateFile) {
      const { saveApprovalState } = await import('../config-io.js')
      await saveApprovalState(repoRoot, 'pending-approvals.json', state, config)
    },
    async writeApproved(_filePath: string, state: import('../core/types.js').ApprovalStateFile) {
      const { saveApprovalState } = await import('../config-io.js')
      await saveApprovalState(repoRoot, 'approved-approvals.json', state, config)
    },
  }
}

export function formatSandboxStatusReport(report: SandboxStatusReport): string {
  const lines = [
    `agent-belay sandbox status for ${report.repoRoot}`,
    `Sandbox: ${report.sandboxEnabled ? 'enabled' : 'disabled'} (runtime=${report.sandboxRuntime})`,
    `Capability broker (fs-scope): ${report.brokerActive ? 'active' : 'inactive'}`,
    `FS-scope allowlist entries: ${report.fsScopeAllowlistCount}`,
    `Control-plane isolation: ${report.controlPlaneIsolationMode} (ok=${report.controlPlaneIsolationOk})`,
    `L1-full active: ${report.l1FullActive}`,
    `  sandbox=${report.l1Full.sandbox} egress=${report.l1Full.egress} proxy=${report.l1Full.egressProxyRunning}`,
    `  isolation=${report.l1Full.controlPlaneIsolation} signing=${report.l1Full.approvalSigningRequired}`,
  ]
  if (report.issues.length > 0) {
    lines.push('Issues:')
    for (const issue of report.issues) {
      lines.push(`  - ${issue}`)
    }
  }
  return `${lines.join('\n')}\n`
}
