import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { inspectGitResourceIdentity } from '../../../git-resource-identity.js'
import type { ShellEffectRequirement } from '../../shell-build.js'
import { addSecretRead, addWriteEffects, processRequirement, requirement } from '../requirement.js'
import { resolvePathOperand } from '../tokens.js'

export function decodeCopyMove(
  head: 'cp' | 'mv',
  args: string[],
  cwd: string,
  segment: string,
): ShellEffectRequirement[] {
  const requirements = [processRequirement(head, 'spawn', segment, ['process.filesystem_mutation'])]
  const operands: string[] = []
  let targetDirectory: string | null = null
  let recursive = false
  let incomplete = false
  let optionsEnded = false
  const neutralFlags = new Set([
    '-f',
    '-i',
    '-n',
    '-p',
    '-v',
    '--force',
    '--interactive',
    '--no-clobber',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && (arg === '-r' || arg === '-R' || arg === '--recursive')) {
      recursive = true
      continue
    }
    if (!optionsEnded && (arg === '-t' || arg === '--target-directory')) {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) {
        incomplete = true
      } else {
        targetDirectory = value
        index += 1
      }
      continue
    }
    if (!optionsEnded && arg.startsWith('--target-directory=')) {
      targetDirectory = arg.slice('--target-directory='.length) || null
      incomplete ||= !targetDirectory
      continue
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (!neutralFlags.has(arg)) {
        incomplete = true
      }
      continue
    }
    operands.push(arg)
  }

  const sources = targetDirectory ? operands : operands.slice(0, -1)
  const destination = targetDirectory ?? (operands.length >= 2 ? (operands.at(-1) ?? null) : null)
  if (sources.length === 0 || !destination) {
    incomplete = true
  }
  for (const source of sources) {
    const resolved = resolvePathOperand(source, cwd)
    requirements.push(
      requirement('fs.read', 'fs.read', { kind: 'path', path: resolved }, segment, [
        `${head}.source_read`,
      ]),
    )
    addSecretRead(requirements, resolved, segment)
    if (head === 'mv') {
      addWriteEffects(requirements, resolved, segment, ['mv.source_remove'])
    }
  }
  if (destination) {
    addWriteEffects(requirements, resolvePathOperand(destination, cwd), segment, [
      `${head}.destination_write`,
    ])
  }
  if (recursive || incomplete) {
    requirements.push(
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        recursive ? `${head}.recursive_source` : `${head}.grammar_incomplete`,
      ]),
    )
  }
  return requirements
}

export function decodeRm(
  args: string[],
  cwd: string,
  repoRoot: string,
  segment: string,
): ShellEffectRequirement[] {
  const requirements = [processRequirement('rm', 'spawn', segment, ['process.filesystem_mutation'])]
  const recursive = args.some(
    (arg) => arg === '-r' || arg === '-R' || arg === '--recursive' || /^-[^-]*[rR]/.test(arg),
  )
  const operands = args.filter((arg) => arg && !arg.startsWith('-'))
  if (operands.length === 0) {
    return [
      ...requirements,
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'rm.operand_missing',
      ]),
    ]
  }
  const identity = inspectGitResourceIdentity(repoRoot)
  for (const operand of operands) {
    const resolved = resolvePathOperand(operand, cwd)
    addWriteEffects(requirements, resolved, segment, ['filesystem.write', 'rm.remove'])
    const finalOperandIsSymlink = isSymbolicLink(resolved)
    const canonicalResolved = canonicalRmOperand(resolved, finalOperandIsSymlink)
    const targetIdentity =
      recursive && !finalOperandIsSymlink
        ? inspectGitResourceIdentity(resolved)
        : { status: 'absent' as const }
    const sameIdentityTargetRoot =
      identity.status === 'resolved' &&
      targetIdentity.status === 'resolved' &&
      identity.identity.commonDir === targetIdentity.identity.commonDir &&
      pathContains(canonicalResolved, targetIdentity.identity.repositoryRoot)
    if (
      recursive &&
      identity.status === 'resolved' &&
      (sameIdentityTargetRoot ||
        [
          repoRoot,
          identity.identity.repositoryRoot,
          identity.identity.gitDir,
          identity.identity.commonDir,
          identity.identity.gitEntryPath,
        ].some((metadataPath) => pathContains(canonicalResolved, metadataPath)))
    ) {
      const gitEntryPath =
        targetIdentity.status === 'resolved'
          ? targetIdentity.identity.gitEntryPath
          : identity.identity.gitEntryPath
      requirements.push(
        requirement(
          'control_plane.write',
          'control_plane.write',
          { kind: 'path', path: gitEntryPath },
          segment,
          ['rm.recursive_git_boundary', 'tier1_catastrophic'],
        ),
      )
    }
  }
  return requirements
}

export function canonicalRmOperand(targetPath: string, finalOperandIsSymlink: boolean): string {
  try {
    if (finalOperandIsSymlink) {
      return path.join(realpathSync.native(path.dirname(targetPath)), path.basename(targetPath))
    }
    return realpathSync.native(targetPath)
  } catch {
    return path.resolve(targetPath)
  }
}

export function isSymbolicLink(targetPath: string): boolean {
  try {
    return lstatSync(targetPath).isSymbolicLink()
  } catch {
    return false
  }
}

export function pathContains(ancestor: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(ancestor), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function filesystemReadOperands(head: string, args: string[]): string[] | null {
  switch (head) {
    case 'ls': {
      const operands = args.filter((arg) => arg && !arg.startsWith('-'))
      return operands.length > 0 ? operands : ['.']
    }
    case 'find':
      return findReadOperands(args)
    case 'cat':
    case 'head':
    case 'tail':
    case 'less':
    case 'stat':
    case 'file':
    case 'du':
    case 'wc':
      return args.filter((arg) => arg && !arg.startsWith('-'))
    case 'grep':
    case 'rg':
      return args.slice(1).filter((arg) => arg && !arg.startsWith('-'))
    case 'jq':
      return args.slice(1).filter((arg) => arg && !arg.startsWith('-'))
    default:
      return null
  }
}

export function findReadOperands(args: string[]): string[] | null {
  const mutatingPrimaries = new Set([
    '-delete',
    '-exec',
    '-execdir',
    '-fls',
    '-fprint',
    '-fprintf',
    '-ok',
    '-okdir',
  ])
  if (
    args.some(
      (arg) =>
        mutatingPrimaries.has(arg) ||
        [...mutatingPrimaries].some((primary) => arg.startsWith(`${primary}=`)),
    )
  ) {
    return null
  }
  const paths: string[] = []
  for (const arg of args) {
    if (arg.startsWith('-') || arg === '!' || arg === '(') {
      break
    }
    paths.push(arg)
  }
  return paths.length > 0 ? paths : ['.']
}

export function filesystemWriteOperands(head: string, args: string[]): string[] | null {
  const positional = args.filter((arg) => arg && !arg.startsWith('-'))
  switch (head) {
    case 'touch':
    case 'mkdir':
    case 'rm':
    case 'truncate':
    case 'chmod':
      return positional
    case 'cp':
    case 'mv':
      return positional.length > 0 ? [positional[positional.length - 1] ?? ''] : []
    case 'tee':
      return positional
    default:
      return null
  }
}
