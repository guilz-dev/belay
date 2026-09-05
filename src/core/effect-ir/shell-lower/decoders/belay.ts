import path from 'node:path'

import type { ShellEffectRequirement } from '../../shell-build.js'
import { processRequirement, requirement } from '../requirement.js'

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
  if (judgeCommand || configRead || configJudgeMutation) {
    return [
      processRequirement('belay', 'inspect', segment, [
        'belay_control_plane_command',
        configJudgeMutation ? 'belay.config_judge_mutation' : 'belay.config_read',
      ]),
    ]
  }
  if (approvalAuthorityCommand || configTrustMutation) {
    return [
      requirement(
        'control_plane.write',
        'control_plane.write',
        { kind: 'path', path: path.join(repoRoot, '.belay-control-plane') },
        segment,
        [approvalAuthorityCommand ? 'belay.approval_authority' : 'belay.config_trust'],
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
