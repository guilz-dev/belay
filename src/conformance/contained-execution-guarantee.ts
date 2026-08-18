/**
 * Normative contained-execution capability contract.
 *
 * This is intentionally not a LayerProfileId: it describes one opt-in mediated execution and
 * never upgrades the surrounding configuration to L1-full.
 */
export interface ContainedUnknownExecutionGuarantee {
  id: 'contained-unknown-execution-v1'
  optIn: true
  runtime: 'docker-only'
  l1Full: false
  materializesGrants: false
  deniesUngrantedEffects: false
  authority: {
    shell: 'effect-plan-only'
    commandIdentityEligibility: false
    forbiddenInputs: readonly [
      'executable',
      'prefix',
      'fingerprint',
      'corpus-membership',
      'framework-identity',
    ]
  }
  audit: { wouldMediate: true; executesContainedCommand: false; executesHostCommand: false }
  enforce: {
    originalHostCommand: 'deny'
    mirror: 'file_copy'
    startsAtMostOnce: true
    workspaceChanges: 'discard'
    output: 'scrubbed-16KiB-tails'
    audit: 'safe-metadata-only'
  }
  attestation: {
    signed: true
    fresh: true
    immutableImageId: true
    configuredDockerBinary: 'absolute-bound'
    configuredDockerSocket: 'local-unix-bound'
    daemonIdentity: true
    configurationBound: true
  }
  boundary: {
    network: 'none'
    readOnlyRoot: true
    sanitizedHostEnvironment: true
    resourceLimits: true
    logDriver: 'none'
    mount: 'one-private-mirror-at-original-guest-path'
    excluded: readonly [
      'host-source',
      'git-metadata',
      'control-plane',
      'docker-socket',
      'devices',
      'unrelated-host-paths',
    ]
    cleanupConfirmed: true
  }
  fallback: {
    approvalOnly: readonly [
      'contained_execution_docker_substrate_unavailable',
      'contained_execution_docker_daemon_unavailable',
    ]
  }
  failClosed: readonly [
    'contained_execution_capability_invalid',
    'contained_execution_capability_mismatch',
    'contained_execution_image_missing',
    'contained_execution_image_mismatch',
    'contained_execution_invalid_mirror_lease',
    'contained_execution_cleanup_unconfirmed',
    'contained_execution_create_failed',
    'contained_execution_inspect_failed',
    'contained_execution_start_attempt_failed',
    'contained_execution_timeout',
  ]
}

export type ContainedUnknownExecutionScenario =
  | { id: string; kind: 'eligible-unknown-local'; command: string }
  | { id: string; kind: 'ineligible-network'; command: string }

export const CONTAINED_UNKNOWN_EXECUTION_GUARANTEE: ContainedUnknownExecutionGuarantee = {
  id: 'contained-unknown-execution-v1',
  optIn: true,
  runtime: 'docker-only',
  l1Full: false,
  materializesGrants: false,
  deniesUngrantedEffects: false,
  authority: {
    shell: 'effect-plan-only',
    commandIdentityEligibility: false,
    forbiddenInputs: [
      'executable',
      'prefix',
      'fingerprint',
      'corpus-membership',
      'framework-identity',
    ],
  },
  audit: { wouldMediate: true, executesContainedCommand: false, executesHostCommand: false },
  enforce: {
    originalHostCommand: 'deny',
    mirror: 'file_copy',
    startsAtMostOnce: true,
    workspaceChanges: 'discard',
    output: 'scrubbed-16KiB-tails',
    audit: 'safe-metadata-only',
  },
  attestation: {
    signed: true,
    fresh: true,
    immutableImageId: true,
    configuredDockerBinary: 'absolute-bound',
    configuredDockerSocket: 'local-unix-bound',
    daemonIdentity: true,
    configurationBound: true,
  },
  boundary: {
    network: 'none',
    readOnlyRoot: true,
    sanitizedHostEnvironment: true,
    resourceLimits: true,
    logDriver: 'none',
    mount: 'one-private-mirror-at-original-guest-path',
    excluded: [
      'host-source',
      'git-metadata',
      'control-plane',
      'docker-socket',
      'devices',
      'unrelated-host-paths',
    ],
    cleanupConfirmed: true,
  },
  fallback: {
    approvalOnly: [
      'contained_execution_docker_substrate_unavailable',
      'contained_execution_docker_daemon_unavailable',
    ],
  },
  failClosed: [
    'contained_execution_capability_invalid',
    'contained_execution_capability_mismatch',
    'contained_execution_image_missing',
    'contained_execution_image_mismatch',
    'contained_execution_invalid_mirror_lease',
    'contained_execution_cleanup_unconfirmed',
    'contained_execution_create_failed',
    'contained_execution_inspect_failed',
    'contained_execution_start_attempt_failed',
    'contained_execution_timeout',
  ],
}

/** Executable EffectPlan scenarios; routing and output use the gate/executor suites. */
export const CONTAINED_UNKNOWN_EXECUTION_SCENARIOS: readonly ContainedUnknownExecutionScenario[] = [
  {
    id: 'cue-eligible-fictional',
    kind: 'eligible-unknown-local',
    command: 'fictional-runner verify',
  },
  {
    id: 'cue-eligible-rails',
    kind: 'eligible-unknown-local',
    command: "bin/rails runner 'Record.count'",
  },
  {
    id: 'cue-eligible-rspec',
    kind: 'eligible-unknown-local',
    command: 'bundle exec rspec --dry-run',
  },
  { id: 'cue-ineligible-network', kind: 'ineligible-network', command: 'curl https://example.com' },
]
