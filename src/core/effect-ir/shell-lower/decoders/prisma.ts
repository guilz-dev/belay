import type { ShellEffectRequirement } from '../../shell-build.js'
import { processRequirement, requirement } from '../requirement.js'
import { databaseEndpoint, LOOPBACK_HOSTS } from '../tokens.js'

export function decodePrisma(
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
  segment: string,
): ShellEffectRequirement[] {
  const processEffect = processRequirement('prisma', 'spawn', segment, ['process.prisma'])
  if (args[0] === 'generate') {
    return [
      processEffect,
      requirement('fs.write', 'fs.write', { kind: 'path', path: repoRoot }, segment, [
        'prisma.generate.repo_local',
      ]),
    ]
  }
  const databaseMutation =
    args[0] === 'migrate' || (args[0] === 'db' && args[1] === 'seed') || args[0] === 'seed'
  if (!databaseMutation) {
    return [
      processEffect,
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'prisma.grammar_incomplete',
      ]),
    ]
  }

  const endpoint = databaseEndpoint(env.DATABASE_URL)
  if (!endpoint) {
    return [
      processEffect,
      requirement(
        'network.connect',
        'network.connect',
        {
          kind: 'network',
          host: 'unknown',
          protocol: 'database',
          mode: 'ambiguous',
          payload: 'present',
        },
        segment,
        ['prisma.database_endpoint_unknown'],
      ),
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'prisma.database_endpoint_unknown',
      ]),
    ]
  }
  const network = requirement(
    'network.connect',
    'network.connect',
    {
      kind: 'network',
      ...endpoint,
      mode: 'mutate',
      payload: 'present',
    },
    segment,
    [LOOPBACK_HOSTS.has(endpoint.host) ? 'prisma.database_local' : 'prisma.database_remote'],
  )
  if (LOOPBACK_HOSTS.has(endpoint.host)) {
    return [processEffect, network]
  }
  return [
    processEffect,
    network,
    requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
      'prisma.remote_database_mutation',
    ]),
  ]
}
