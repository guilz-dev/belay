import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { loadApprovalState } from '../../config-io.js'
import { evaluateGuaranteePosture } from '../../conformance/guarantee-posture.js'
import { isDockerAvailable } from '../../core/capability/boundary-driver-container.js'
import { startBoundarySession } from '../../core/capability/boundary-session.js'
import { evaluateL1FullStatus } from '../../core/capability/broker.js'
import { DEFAULT_CONFIG_V4, mergeConfig } from '../../core/config.js'
import { classifyShell } from '../../core/verdict/adapter.js'

const dockerAvailable = await isDockerAvailable()
const tempDirs: string[] = []

function l1FullConfig() {
  return {
    ...DEFAULT_CONFIG_V4,
    version: 5 as const,
    sandbox: { ...DEFAULT_CONFIG_V4.sandbox, enabled: true, runtime: 'container' as const },
    egress: { ...DEFAULT_CONFIG_V4.egress, enabled: true },
    approvalSigning: { required: true },
    controlPlane: {
      ...DEFAULT_CONFIG_V4.controlPlane,
      isolation: { mode: 'separate-user' as const, verifyAgentWritable: true },
    },
  }
}

describe('capability fail-closed gate', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('deactivates L1-full when egress proxy is not running', () => {
    const config = l1FullConfig()
    const l1 = evaluateL1FullStatus({ config, egressProxyRunning: false })
    expect(l1.active).toBe(false)
    expect(l1.egressProxyRunning).toBe(false)
  })

  it('reports posture mismatch when L1-full is configured but attestation is missing', () => {
    const config = l1FullConfig()
    const posture = evaluateGuaranteePosture({
      config,
      attestation: null,
      egressProxyRunning: true,
    })
    expect(posture.configuredProfile).toBe('l1-full')
    expect(posture.attestedProfile).toBe('l3-l4-only')
    expect(posture.l1FullConfigured).toBe(true)
    expect(posture.l1FullAttested).toBe(false)
    expect(posture.postureMismatch).toBe(true)
  })

  it('requires approval for network commands at L3 regardless of egress proxy', async () => {
    const config = mergeConfig({})
    const result = await classifyShell(
      'curl https://example.com',
      '/workspace/project/src',
      '/workspace/project',
      config,
    )
    expect(result.verdict).toBe('deny_pending_approval')
    expect(result.authorizationDecision?.outcome).toBe('require_approval')
  })

  it('returns empty approval state for corrupt JSON files', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-corrupt-approval-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    const approvalsPath = path.join(repoRoot, '.cursor', 'belay', 'approved-approvals.json')
    await writeFile(approvalsPath, '{not-json', 'utf8')

    const config = mergeConfig({})
    const state = await loadApprovalState(repoRoot, 'approved-approvals.json', config)
    expect(state.approvals).toEqual([])
  })

  it.skipIf(dockerAvailable)('does not write attestation when container probe fails', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-session-no-attest-'))
    tempDirs.push(repoRoot)
    const config = {
      ...l1FullConfig(),
      capability: {
        attestationRelPath: '.belay/attestation.json',
        boundaryDriver: 'container' as const,
      },
    }
    const attestationPath = path.join(repoRoot, '.belay', 'attestation.json')

    await expect(
      startBoundarySession({
        repoRoot,
        config,
        egressProxyRunning: true,
      }),
    ).rejects.toThrow()

    expect(existsSync(attestationPath)).toBe(false)
  })
})
