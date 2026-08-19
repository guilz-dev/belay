import { OUTPUT_TAIL_LIMIT_BYTES } from '../core/bounded-output.js'
import { CONTAINED_EXECUTION_APPROVAL_FALLBACK_REASONS } from '../core/contained-execution/policy.js'

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
  audit: {
    wouldMediate: true
    containedRouteExecution: 'none'
    readsAttestation: false
    preparesMirror: false
    startsContainer: false
    gatePermission: 'allow'
    hostExecution: 'delegated-to-host'
  }
  enforce: {
    originalHostCommand: 'deny'
    mirror: 'file_copy'
    startsAtMostOnce: true
    workspaceChanges: 'discard'
    output: {
      scrub: 'mandatory'
      tailBytes: 16384
      userRedactionCanDisable: false
    }
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
    approvalOnly: typeof CONTAINED_EXECUTION_APPROVAL_FALLBACK_REASONS
  }
  failure: {
    /** Every setup failure other than the exact approval fallback set denies before host replay. */
    setup: {
      categories: readonly [
        'boundary',
        'capability',
        'image',
        'mirror',
        'lease',
        'container-lifecycle',
        'cleanup',
      ]
      outcome: 'deny'
      hostExecution: 'deny'
      approval: 'none'
      approvalStateMutation: 'none'
    }
    /** A started container that times out or exits nonzero is terminal, never an approval. */
    command: {
      timeout: 'contained_execution_failed'
      nonzero: 'contained_execution_failed'
      hostExecution: 'deny'
      approval: 'none'
    }
  }
  outcomes: {
    success: {
      exitCode: 0
      outcome: 'contained_execution_complete'
      hostExecution: 'deny'
      approval: 'none'
    }
  }
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
  audit: {
    wouldMediate: true,
    containedRouteExecution: 'none',
    readsAttestation: false,
    preparesMirror: false,
    startsContainer: false,
    gatePermission: 'allow',
    hostExecution: 'delegated-to-host',
  },
  enforce: {
    originalHostCommand: 'deny',
    mirror: 'file_copy',
    startsAtMostOnce: true,
    workspaceChanges: 'discard',
    output: {
      scrub: 'mandatory',
      tailBytes: OUTPUT_TAIL_LIMIT_BYTES,
      userRedactionCanDisable: false,
    },
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
    approvalOnly: CONTAINED_EXECUTION_APPROVAL_FALLBACK_REASONS,
  },
  failure: {
    setup: {
      categories: [
        'boundary',
        'capability',
        'image',
        'mirror',
        'lease',
        'container-lifecycle',
        'cleanup',
      ],
      outcome: 'deny',
      hostExecution: 'deny',
      approval: 'none',
      approvalStateMutation: 'none',
    },
    command: {
      timeout: 'contained_execution_failed',
      nonzero: 'contained_execution_failed',
      hostExecution: 'deny',
      approval: 'none',
    },
  },
  outcomes: {
    success: {
      exitCode: 0,
      outcome: 'contained_execution_complete',
      hostExecution: 'deny',
      approval: 'none',
    },
  },
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
