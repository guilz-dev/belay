import type { ShellEffectRequirement } from '../../shell-build.js'
import {
  addWriteEffects,
  processRequirement,
  requirement,
  unsupportedProcess,
} from '../requirement.js'
import { resolvePathOperand } from '../tokens.js'

export function decodeTsc(args: string[], cwd: string, segment: string): ShellEffectRequirement[] {
  const metadataOnly =
    args.length > 0 && args.every((arg) => ['--help', '--version', '-h', '-v'].includes(arg))
  const requirements: ShellEffectRequirement[] = []
  let hasOutput = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    const inline = arg.match(/^--(?:outDir|outFile)=(.+)$/)?.[1]
    const separate =
      (arg === '--outDir' || arg === '--outFile') && args[index + 1] ? args[index + 1] : null
    const output = inline ?? separate
    if (!output) {
      continue
    }
    hasOutput = true
    addWriteEffects(requirements, resolvePathOperand(output, cwd), segment, ['tsc.output'])
    if (separate) {
      index += 1
    }
  }
  const typecheckOnly = args.includes('--noEmit') && !hasOutput
  const inspect = metadataOnly || typecheckOnly
  requirements.unshift(
    processRequirement('tsc', inspect ? 'inspect' : 'spawn', segment, [
      metadataOnly
        ? 'process.inspect.tsc_metadata'
        : typecheckOnly
          ? 'process.inspect.tsc_typecheck'
          : 'process.known_local_spawn',
    ]),
  )
  return requirements
}

export function decodeGo(args: string[], segment: string): ShellEffectRequirement[] {
  if (['test', 'list', 'vet'].includes(args[0] ?? '')) {
    return [processRequirement('go', 'spawn', segment, ['process.go_local_spawn'])]
  }
  if (args[0] === 'install' || (args[0] === 'mod' && args[1] === 'download')) {
    return [
      processRequirement('go', 'spawn', segment, ['process.go_acquire']),
      requirement(
        'network.acquire',
        'network.connect',
        {
          kind: 'network',
          host: 'unknown',
          protocol: 'go-module',
          mode: 'ambiguous',
          payload: 'none',
        },
        segment,
        ['go.network_acquisition_possible'],
      ),
    ]
  }
  return unsupportedProcess('go', segment, 'process.go_grammar_incomplete')
}

export function decodeRsync(
  args: string[],
  cwd: string,
  segment: string,
): ShellEffectRequirement[] {
  const destructive = args.some(
    (arg) => arg === '--delete' || arg === '--del' || arg.startsWith('--delete-'),
  )
  if (destructive) {
    return [
      processRequirement('rsync', 'spawn', segment, ['rsync_destructive']),
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'rsync_destructive',
      ]),
    ]
  }
  const allowedFlags = new Set([
    '-a',
    '-r',
    '-v',
    '-z',
    '--archive',
    '--delay-updates',
    '--recursive',
    '--verbose',
  ])
  if (args.some((arg) => arg.startsWith('-') && !allowedFlags.has(arg))) {
    return unsupportedProcess('rsync', segment, 'process.rsync_grammar_incomplete')
  }
  const operands = args.filter((arg) => !arg.startsWith('-'))
  if (operands.length < 2) {
    return unsupportedProcess('rsync', segment, 'process.rsync_operands_incomplete')
  }
  if (operands.some(isRemoteRsyncOperand)) {
    return [
      processRequirement('rsync', 'spawn', segment, ['rsync.remote']),
      requirement(
        'network.connect',
        'network.connect',
        {
          kind: 'network',
          host: 'remote',
          protocol: 'rsync',
          mode: 'mutate',
          payload: 'present',
        },
        segment,
        ['rsync.remote'],
      ),
    ]
  }
  const destination = operands.at(-1) ?? ''
  return [
    processRequirement('rsync', 'spawn', segment, ['process.rsync_local']),
    ...operands
      .slice(0, -1)
      .map((operand) =>
        requirement(
          'fs.read',
          'fs.read',
          { kind: 'path', path: resolvePathOperand(operand, cwd) },
          segment,
          ['rsync.local_source'],
        ),
      ),
    requirement(
      'fs.write',
      'fs.write',
      { kind: 'path', path: resolvePathOperand(destination, cwd) },
      segment,
      ['rsync.local_destination'],
    ),
  ]
}

export function isRemoteRsyncOperand(operand: string): boolean {
  return (
    /^rsync:\/\//i.test(operand) ||
    /^[^/:\s]+::/.test(operand) ||
    /^(?:[^@/:\s]+@)?[^/:\s]+:/.test(operand)
  )
}

export function decodeSed(args: string[], cwd: string, segment: string): ShellEffectRequirement[] {
  let inline = false
  let scriptConsumed = false
  const files: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
      continue
    }
    if (arg === '-i' || arg === '--in-place' || arg.startsWith('-i')) {
      inline = true
      continue
    }
    if (arg === '-e' || arg === '--expression') {
      if (!args[index + 1]) {
        return unsupportedProcess('sed', segment, 'process.sed_expression_missing')
      }
      scriptConsumed = true
      index += 1
      continue
    }
    if (arg.startsWith('--expression=')) {
      scriptConsumed = true
      continue
    }
    if (arg.startsWith('-')) {
      return unsupportedProcess('sed', segment, 'process.sed_grammar_incomplete')
    }
    if (!scriptConsumed) {
      scriptConsumed = true
      continue
    }
    files.push(arg)
  }
  const operation = inline ? 'spawn' : 'inspect'
  const lowered = [processRequirement('sed', operation, segment, ['process.sed'])]
  for (const file of files) {
    lowered.push(
      requirement(
        inline ? 'fs.write' : 'fs.read',
        inline ? 'fs.write' : 'fs.read',
        { kind: 'path', path: resolvePathOperand(file, cwd) },
        segment,
        [inline ? 'sed.in_place_write' : 'sed.file_read'],
      ),
    )
  }
  return lowered
}

export function decodeNode(args: string[], cwd: string, segment: string): ShellEffectRequirement[] {
  if (args.length > 0 && args.every((arg) => ['--help', '--version', '-h', '-v'].includes(arg))) {
    return [processRequirement('node', 'inspect', segment, ['process.inspect.node_metadata'])]
  }
  if ((args[0] === '--check' || args[0] === '-c') && args.length === 2 && args[1]) {
    return [
      processRequirement('node', 'inspect', segment, ['process.inspect.node_syntax']),
      requirement(
        'fs.read',
        'fs.read',
        { kind: 'path', path: resolvePathOperand(args[1], cwd) },
        segment,
        ['node.syntax_source_read'],
      ),
    ]
  }
  return unsupportedProcess('node', segment, 'process.node_grammar_incomplete')
}
