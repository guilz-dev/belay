import { isContainedExecutionApprovalFallbackReason } from './policy.js'

export const CONTAINED_EXECUTION_FAILURE_CODES = [
  'contained_execution_boundary_failed',
  'contained_execution_capability_invalid',
  'contained_execution_capability_mismatch',
  'contained_execution_cleanup_unconfirmed',
  'contained_execution_container_cleanup_unconfirmed',
  'contained_execution_control_plane_roots_required',
  'contained_execution_create_failed',
  'contained_execution_create_invalid',
  'contained_execution_create_mismatch',
  'contained_execution_create_timeout',
  'contained_execution_create_truncated',
  'contained_execution_disabled',
  'contained_execution_docker_binary_invalid',
  'contained_execution_docker_config_missing',
  'contained_execution_docker_daemon_invalid',
  'contained_execution_docker_daemon_unavailable',
  'contained_execution_docker_host_invalid',
  'contained_execution_docker_substrate_mismatch',
  'contained_execution_docker_substrate_overlap',
  'contained_execution_docker_substrate_unavailable',
  'contained_execution_host_identity_unavailable',
  'contained_execution_image_inspect_invalid',
  'contained_execution_image_inspect_truncated',
  'contained_execution_image_mismatch',
  'contained_execution_image_missing',
  'contained_execution_input_fingerprint_invalid',
  'contained_execution_inspect_failed',
  'contained_execution_inspect_invalid',
  'contained_execution_inspect_mismatch',
  'contained_execution_inspect_timeout',
  'contained_execution_inspect_truncated',
  'contained_execution_invalid_container_name',
  'contained_execution_invalid_cwd',
  'contained_execution_invalid_image_id',
  'contained_execution_invalid_mirror_lease',
  'contained_execution_invalid_mount',
  'contained_execution_invalid_user',
  'contained_execution_mirror_limits_invalid',
  'contained_execution_probe_create_failed',
  'contained_execution_probe_failed',
  'contained_execution_probe_inspect_failed',
  'contained_execution_probe_inspect_invalid',
  'contained_execution_probe_inspect_truncated',
  'contained_execution_probe_root_cleanup_unconfirmed',
  'contained_execution_protected_root_overlap',
  'contained_execution_resource_limits_invalid',
  'contained_execution_safe_open_unavailable',
  'contained_execution_source_changed',
  'contained_execution_source_is_protected',
  'contained_execution_source_not_directory',
  'contained_execution_start_attempt_failed',
  'contained_execution_unknown_option',
  'contained_execution_unsafe_symlink',
] as const

export type ContainedExecutionFailureCode = (typeof CONTAINED_EXECUTION_FAILURE_CODES)[number]
export type ContainedExecutionFailurePhase =
  | 'boundary'
  | 'capability'
  | 'image'
  | 'mirror'
  | 'lease'
  | 'container-lifecycle'
  | 'cleanup'

export type ContainedExecutionFailureDisposition = 'approval-fallback' | 'deny'
export type ContainedExecutionFailureRemediation = 'session-start' | 'none'

const failureCodes: ReadonlySet<string> = new Set(CONTAINED_EXECUTION_FAILURE_CODES)
const mirrorFailureCodes: ReadonlySet<ContainedExecutionFailureCode> = new Set([
  'contained_execution_control_plane_roots_required',
  'contained_execution_mirror_limits_invalid',
  'contained_execution_safe_open_unavailable',
  'contained_execution_source_changed',
  'contained_execution_source_is_protected',
  'contained_execution_source_not_directory',
  'contained_execution_unsafe_symlink',
])

export function isContainedExecutionFailureCode(
  value: unknown,
): value is ContainedExecutionFailureCode {
  return typeof value === 'string' && failureCodes.has(value)
}

export function containedExecutionFailurePhase(
  code: ContainedExecutionFailureCode,
): ContainedExecutionFailurePhase {
  if (code.includes('cleanup')) return 'cleanup'
  if (code.includes('capability')) return 'capability'
  if (code.includes('image')) return 'image'
  if (code.includes('lease')) return 'lease'
  if (mirrorFailureCodes.has(code)) return 'mirror'
  if (/_(?:create|inspect|start|probe)_/.test(code)) return 'container-lifecycle'
  return 'boundary'
}

export class ContainedExecutionFailureError extends Error {
  readonly phase: ContainedExecutionFailurePhase
  readonly executionStarted: boolean
  readonly disposition: ContainedExecutionFailureDisposition
  readonly remediation: ContainedExecutionFailureRemediation

  constructor(
    readonly code: ContainedExecutionFailureCode,
    options?: ErrorOptions & {
      phase?: ContainedExecutionFailurePhase
      executionStarted?: boolean
    },
  ) {
    super(code, options)
    this.name = 'ContainedExecutionFailureError'
    this.phase = options?.phase ?? containedExecutionFailurePhase(code)
    this.executionStarted = options?.executionStarted ?? false
    this.disposition = isContainedExecutionApprovalFallbackReason(code)
      ? 'approval-fallback'
      : 'deny'
    this.remediation =
      this.phase === 'capability' || this.phase === 'image' || code.includes('_docker_')
        ? 'session-start'
        : 'none'
  }
}
