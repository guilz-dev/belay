import {
  classifyPackageAcquisitionSpec,
  type peelPackageExecArgv,
  resolveLocalBin,
} from '../../package-exec.js'
import type { ShellEffectRequirement } from '../../shell-build.js'
import { requirement } from '../requirement.js'

export function decodePackageExec(
  peel: NonNullable<ReturnType<typeof peelPackageExecArgv>>,
  cwd: string,
  repoRoot: string,
  segment: string,
): ShellEffectRequirement[] {
  if (peel.opaque) {
    return [
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        peel.reason,
        ...peel.signals,
      ]),
    ]
  }
  if (peel.reason === 'npx_wrapper_readonly') {
    return []
  }

  const binHead = peel.innerTokens[0] ?? ''
  const metadataOnly = packageExecInnerIsMetadata(peel)
  const local = !peel.forceAcquire ? resolveLocalBin(binHead, cwd, repoRoot) : null
  if (local) {
    return metadataOnly
      ? [
          requirement(
            'process.exec',
            'process.exec',
            { kind: 'executable', command: local.path, operation: 'inspect' },
            segment,
            ['package_exec.delegate', 'package_exec.local_bin_resolved'],
          ),
        ]
      : []
  }

  const networkResources = peel.acquisitionSpecs
    .map((spec) => classifyPackageAcquisitionSpec(spec))
    .filter((source) => source.kind !== 'local')
    .map((source) =>
      source.kind === 'registry'
        ? {
            kind: 'network' as const,
            host: 'registry.npmjs.org',
            protocol: 'registry',
            mode: 'read' as const,
            payload: 'none' as const,
          }
        : {
            kind: 'network' as const,
            host: source.host,
            ...(source.port ? { port: source.port } : {}),
            protocol: source.protocol,
            mode: 'read' as const,
            payload: 'none' as const,
          },
    )
  if (networkResources.length === 0) {
    networkResources.push({
      kind: 'network',
      host: 'registry.npmjs.org',
      protocol: 'registry',
      mode: 'read',
      payload: 'none',
    })
  }
  return [
    ...networkResources.map((resource) =>
      requirement('network.acquire', 'network.connect', resource, segment, [
        'package_acquire_possible',
      ]),
    ),
    requirement(
      'fs.write',
      'fs.write',
      { kind: 'package-cache', manager: peel.launcher === 'pnpm' ? 'pnpm' : 'npm' },
      segment,
      ['package_cache_write'],
    ),
    ...(metadataOnly
      ? [
          requirement(
            'process.exec',
            'process.exec',
            { kind: 'executable', command: binHead || peel.launcher, operation: 'inspect' },
            segment,
            ['package_exec.delegate'],
          ),
        ]
      : []),
  ]
}

export function packageExecInnerIsMetadata(
  peel: NonNullable<ReturnType<typeof peelPackageExecArgv>>,
): boolean {
  const args = peel.innerTokens.slice(1)
  return (
    args.length > 0 && args.every((arg) => ['--help', '--version', '-V', '-h', '-v'].includes(arg))
  )
}
