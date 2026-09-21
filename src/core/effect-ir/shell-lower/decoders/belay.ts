import path from 'node:path'

import type { ShellEffectRequirement } from '../../shell-build.js'
import { processRequirement, requirement } from '../requirement.js'

const MANIFEST_SUBCOMMANDS = new Set(['infer', 'list', 'show', 'validate', 'trust', 'revoke'])
// Keep aligned with the one-value options consumed by cli.ts parseArgs before
// it dispatches a manifest subcommand. Exact arity prevents option values such
// as "infer" from being mistaken for the actual subcommand.
const CLI_OPTIONS_WITH_ONE_VALUE = new Set([
  '--adapter',
  '--preset',
  '--judge-profile',
  '--judge-provider',
  '--judge-endpoint',
  '--judge-model',
  '--cloud-consent-approval-id',
  '--credential',
  '--key-env',
  '--timeout',
  '--audit-version',
  '--boundary-profile',
  '--since',
  '--until',
  '--verdict',
  '--reason',
  '--outcome',
  '--corpus',
  '--kind',
  '--fingerprint',
  '--event',
  '--location',
  '--opacity',
  '--effect',
  '--confidence',
  '--limit',
  '--config',
  '--token',
  '--scope',
  '--path',
  '--target',
  '--cwd',
  '--rule',
  '--command',
  '--tool',
  '--payload-json',
])

function manifestSubcommand(args: readonly string[]): string | undefined {
  if (args[0] !== 'manifest') {
    return undefined
  }
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]
    if (!token) {
      return undefined
    }
    if (MANIFEST_SUBCOMMANDS.has(token)) {
      return token
    }
    if (token === '--') {
      return undefined
    }
    if (!token.startsWith('-')) {
      return undefined
    }
    if (CLI_OPTIONS_WITH_ONE_VALUE.has(token)) {
      if (args[index + 1] === undefined) {
        return undefined
      }
      index += 1
    }
  }
  return undefined
}

export function decodeBelay(
  args: string[],
  repoRoot: string,
  segment: string,
): ShellEffectRequirement[] {
  const [section, operation, key] = args
  const judgeCommand =
    section === 'judge' &&
    operation !== undefined &&
    ['consent', 'list', 'status', 'test', 'use'].includes(operation)
  const configRead =
    section === 'config' &&
    (operation === undefined ||
      operation === 'list' ||
      (operation === 'get' && key?.startsWith('judge.')))
  const configJudgeMutation =
    section === 'config' &&
    ((['set', 'unset'].includes(operation ?? '') && key?.startsWith('judge.')) ||
      (operation === 'credential' && key === 'mode'))
  const approvalAuthorityCommand = [
    'approval-token',
    'approve',
    'revoke',
    'standing-allow',
  ].includes(section ?? '')
  const configTrustMutation = section === 'config' && operation === 'trust'
  const manifestOperation = manifestSubcommand(args)
  const manifestTrustMutation = manifestOperation === 'trust' || manifestOperation === 'revoke'
  if (judgeCommand || configRead || configJudgeMutation) {
    return [
      processRequirement('belay', 'inspect', segment, [
        'belay_control_plane_command',
        configJudgeMutation ? 'belay.config_judge_mutation' : 'belay.config_read',
      ]),
    ]
  }
  if (approvalAuthorityCommand || configTrustMutation || manifestTrustMutation) {
    return [
      requirement(
        'control_plane.write',
        'control_plane.write',
        { kind: 'path', path: path.join(repoRoot, '.belay-control-plane') },
        segment,
        [
          approvalAuthorityCommand
            ? 'belay.approval_authority'
            : manifestTrustMutation
              ? 'belay.effect_manifest_trust'
              : 'belay.config_trust',
        ],
      ),
    ]
  }
  if (section === 'config' && ['set', 'unset', 'credential'].includes(operation ?? '')) {
    return [
      requirement(
        'control_plane.write',
        'control_plane.write',
        { kind: 'path', path: path.join(repoRoot, '.belay-control-plane') },
        segment,
        ['belay.config_non_judge_mutation'],
      ),
    ]
  }
  return [processRequirement('belay', 'spawn', segment, ['process.known_local_spawn'])]
}
