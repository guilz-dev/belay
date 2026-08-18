import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CONTAINED_UNKNOWN_EXECUTION_GUARANTEE,
  CONTAINED_UNKNOWN_EXECUTION_SCENARIOS,
} from '../../conformance/contained-execution-guarantee.js'
import { DEFAULT_CONFIG_V3, normalizeConfig } from '../../core/config.js'
import { isContainedUnknownExecutionEligible } from '../../core/contained-execution/eligibility.js'
import { classifyShellCore } from '../helpers/shell-classify.js'

const repoRoot = '/workspace/contained-guarantee'
const cwd = path.join(repoRoot, 'app')

function containedConfig() {
  return normalizeConfig({
    ...DEFAULT_CONFIG_V3,
    sandbox: {
      enabled: true,
      runtime: 'container',
      denyNetworkByDefault: true,
      containedExecution: {
        enabled: true,
        image: 'local/contained:1',
        dockerExecutable: '/usr/local/bin/docker',
        dockerHost: 'unix:///var/run/docker.sock',
        timeoutMs: 30_000,
        memoryMiB: 2048,
        cpus: 2,
        pids: 256,
      },
    },
  })
}

describe('contained unknown execution guarantee conformance', () => {
  it('is a separate Docker-only capability and never an L1-full profile', () => {
    expect(CONTAINED_UNKNOWN_EXECUTION_GUARANTEE).toMatchObject({
      id: 'contained-unknown-execution-v1',
      optIn: true,
      runtime: 'docker-only',
      l1Full: false,
      materializesGrants: false,
      deniesUngrantedEffects: false,
      authority: {
        shell: 'effect-plan-only',
        commandIdentityEligibility: false,
      },
      audit: { wouldMediate: true, executesContainedCommand: false },
      enforce: { originalHostCommand: 'deny', mirror: 'file_copy', startsAtMostOnce: true },
      fallback: {
        approvalOnly: [
          'contained_execution_docker_substrate_unavailable',
          'contained_execution_docker_daemon_unavailable',
        ],
      },
    })
    expect(CONTAINED_UNKNOWN_EXECUTION_GUARANTEE.failClosed).toContain(
      'contained_execution_cleanup_unconfirmed',
    )
  })

  it('keeps fictional and ecosystem command names on the same EffectPlan eligibility route', async () => {
    const config = containedConfig()
    for (const scenario of CONTAINED_UNKNOWN_EXECUTION_SCENARIOS.filter(
      (scenario) => scenario.kind === 'eligible-unknown-local',
    )) {
      const result = await classifyShellCore(scenario.command, cwd, repoRoot)
      expect(result.reason, scenario.id).toBe('unknown_local_effect')
      expect(
        isContainedUnknownExecutionEligible(config, { kind: 'shell', repoRoot }, result),
        scenario.id,
      ).toBe(true)
    }
  })

  it('keeps network-bearing unknown commands outside the contained route', async () => {
    const scenario = CONTAINED_UNKNOWN_EXECUTION_SCENARIOS.find(
      (candidate) => candidate.kind === 'ineligible-network',
    )
    if (!scenario) throw new Error('missing network ineligibility scenario')
    const result = await classifyShellCore(scenario.command, cwd, repoRoot)
    expect(
      isContainedUnknownExecutionEligible(containedConfig(), { kind: 'shell', repoRoot }, result),
    ).toBe(false)
  })
})
