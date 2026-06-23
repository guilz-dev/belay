import type { JudgeProviderId } from './judge-catalog.js'

export type JudgeSessionFailureMode =
  | 'parse_error'
  | 'non_json_response'
  | 'timeout'
  | 'cli_nonzero_exit'
  | 'io_error'
  | 'version_mismatch'
  | 'unsupported_resume'
  | 'unsafe_option_rejected'

export interface JudgeProviderSessionCapability {
  providerId: Exclude<JudgeProviderId, 'ollama'>
  supportsSession: boolean
  resumeFlag: string | null
  createChatFlag: string | null
  readOnlyArgs: string[]
  rejectedUnsafeOptions: string[]
  failureModes: JudgeSessionFailureMode[]
  notes: string
}

export const JUDGE_PROVIDER_SESSION_MATRIX: Record<
  Exclude<JudgeProviderId, 'ollama'>,
  JudgeProviderSessionCapability
> = {
  cursor: {
    providerId: 'cursor',
    supportsSession: true,
    resumeFlag: '--resume',
    createChatFlag: null,
    readOnlyArgs: ['--mode', 'ask', '--sandbox', 'enabled', '--trust'],
    rejectedUnsafeOptions: ['--force', '--yolo', '--dangerously-skip-permissions'],
    failureModes: [
      'parse_error',
      'non_json_response',
      'timeout',
      'cli_nonzero_exit',
      'io_error',
      'version_mismatch',
    ],
    notes: 'Pilot provider: ask mode + sandbox enabled; resume via --resume <chatId>.',
  },
  codex: {
    providerId: 'codex',
    supportsSession: false,
    resumeFlag: null,
    createChatFlag: null,
    readOnlyArgs: ['--sandbox', 'read-only'],
    rejectedUnsafeOptions: ['--dangerously-bypass-approvals-and-sandbox'],
    failureModes: ['unsupported_resume', 'parse_error', 'timeout'],
    notes: 'Session transport disabled by default; spawn read-only exec remains canonical.',
  },
  claude: {
    providerId: 'claude',
    supportsSession: false,
    resumeFlag: '--continue',
    createChatFlag: null,
    readOnlyArgs: ['--permission-mode', 'plan', '--tools', '', '--bare'],
    rejectedUnsafeOptions: ['--dangerously-skip-permissions'],
    failureModes: ['unsupported_resume', 'parse_error', 'timeout'],
    notes: 'Session transport gated behind allowlist after capability verification.',
  },
}

export function providerSupportsSession(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  allowlist: JudgeProviderId[],
): boolean {
  const capability = JUDGE_PROVIDER_SESSION_MATRIX[providerId]
  return capability.supportsSession && allowlist.includes(providerId)
}

export function assertReadOnlyInvocationArgs(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  args: string[],
): { ok: true } | { ok: false; reason: JudgeSessionFailureMode } {
  const capability = JUDGE_PROVIDER_SESSION_MATRIX[providerId]
  for (const unsafe of capability.rejectedUnsafeOptions) {
    if (args.includes(unsafe)) {
      return { ok: false, reason: 'unsafe_option_rejected' }
    }
  }

  for (let index = 0; index < capability.readOnlyArgs.length; index += 2) {
    const flag = capability.readOnlyArgs[index]
    const value = capability.readOnlyArgs[index + 1]
    if (!flag) {
      continue
    }
    const flagIndex = args.indexOf(flag)
    if (flagIndex === -1) {
      return { ok: false, reason: 'unsafe_option_rejected' }
    }
    if (value !== undefined && args[flagIndex + 1] !== value) {
      return { ok: false, reason: 'unsafe_option_rejected' }
    }
  }

  return { ok: true }
}
