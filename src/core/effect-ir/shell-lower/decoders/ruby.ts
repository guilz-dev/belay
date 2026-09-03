import path from 'node:path'

import { canonicalPath, pathWithinRoot } from '../../../path-utils.js'
import type { ShellEffectRequirement } from '../../shell-build.js'
import { processRequirement, requirement, unsupportedProcess } from '../requirement.js'
import { executableBaseName, isMetadataOnlyArgv, resolvePathOperand } from '../tokens.js'

const RAILS_READ_ONLY_SUBCOMMANDS = new Set(['routes', 'middleware', 'stats', 'about', 'version'])

export function railsReadOnlySubcommand(args: string[]): boolean {
  const subcommand = args[0]
  if (!subcommand || subcommand.startsWith('-')) {
    return false
  }
  return RAILS_READ_ONLY_SUBCOMMANDS.has(subcommand)
}

export function isRubyTestScript(scriptPath: string): boolean {
  const base = path.basename(scriptPath)
  return base.endsWith('_test.rb') || base.endsWith('_spec.rb')
}

export function parseRubyTestInvocation(
  args: string[],
): { includePaths: string[]; scriptPath: string } | null {
  const includePaths: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '-e' || arg === '-r') {
      return null
    }
    if (arg === '-I') {
      const includePath = args[index + 1]
      if (!includePath) {
        return null
      }
      includePaths.push(includePath)
      index += 1
      continue
    }
    if (arg.startsWith('-I') && arg.length > 2) {
      includePaths.push(arg.slice(2))
      continue
    }
    if (arg.startsWith('-')) {
      if (arg === '-n') {
        if (!args[index + 1]) {
          return null
        }
        index += 1
        continue
      }
      if (arg.startsWith('-n')) {
        continue
      }
      return null
    }
    if (isRubyTestScript(arg)) {
      return { includePaths, scriptPath: arg }
    }
    return null
  }
  return null
}

export function isRubocopMutating(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === '-A' ||
      arg === '-a' ||
      arg === '--auto-correct' ||
      arg === '--autocorrect' ||
      arg.startsWith('--auto-correct-all') ||
      arg.startsWith('--autocorrect-all'),
  )
}

export function decodeBundleExecInner(
  innerHead: string,
  innerArgs: string[],
  segment: string,
): ShellEffectRequirement[] | null {
  const innerBase = executableBaseName(innerHead)
  if (innerBase === 'rubocop') {
    const mutating = isRubocopMutating(innerArgs)
    return [
      processRequirement(
        innerHead,
        mutating ? 'spawn' : 'inspect',
        segment,
        mutating ? ['process.linter.mutating'] : ['process.inspect.linter'],
      ),
    ]
  }
  if (innerBase === 'rspec') {
    const targetArgs = innerArgs.filter((arg) => !arg.startsWith('-'))
    if (targetArgs.length === 0) {
      return null
    }
    return [processRequirement(innerHead, 'spawn', segment, ['process.test_runner.rspec'])]
  }
  return null
}

export function decodeRuby(
  args: string[],
  cwd: string,
  repoRoot: string,
  segment: string,
): ShellEffectRequirement[] {
  const parsed = parseRubyTestInvocation(args)
  if (!parsed) {
    return unsupportedProcess('ruby', segment, 'process.ruby_grammar_incomplete')
  }
  const scriptPath = resolvePathOperand(parsed.scriptPath, cwd)
  if (!pathWithinRoot(canonicalPath(repoRoot), canonicalPath(scriptPath))) {
    return unsupportedProcess('ruby', segment, 'process.ruby_outside_repo')
  }
  for (const includePath of parsed.includePaths) {
    const resolvedInclude = resolvePathOperand(includePath, cwd)
    if (!pathWithinRoot(canonicalPath(repoRoot), canonicalPath(resolvedInclude))) {
      return unsupportedProcess('ruby', segment, 'process.ruby_outside_repo')
    }
  }
  const lowered = [
    processRequirement('ruby', 'spawn', segment, ['process.test_runner.minitest']),
    requirement('fs.read', 'fs.read', { kind: 'path', path: scriptPath }, segment, [
      'ruby.minitest_script_read',
    ]),
  ]
  for (const includePath of parsed.includePaths) {
    lowered.push(
      requirement(
        'fs.read',
        'fs.read',
        { kind: 'path', path: resolvePathOperand(includePath, cwd) },
        segment,
        ['ruby.minitest_load_path_read'],
      ),
    )
  }
  return lowered
}

export function decodeRuntimeMetadataProcess(
  head: string,
  args: string[],
  segment: string,
): ShellEffectRequirement[] | null {
  if (head === 'bundle') {
    if (args.length === 1 && isMetadataOnlyArgv(args)) {
      return [processRequirement(head, 'inspect', segment, ['process.inspect.runtime_metadata'])]
    }
    if (args[0] === 'exec' && args.length >= 2) {
      const innerHead = args[1] ?? ''
      const innerArgs = args.slice(2)
      const innerBase = executableBaseName(innerHead)
      if ((innerBase === 'rails' || innerBase === 'rake') && railsReadOnlySubcommand(innerArgs)) {
        return [
          processRequirement(innerHead, 'inspect', segment, ['process.inspect.rails_read_only']),
        ]
      }
      if (isMetadataOnlyArgv(innerArgs)) {
        return [
          processRequirement(innerHead, 'inspect', segment, [
            'process.inspect.bundle_exec_metadata',
          ]),
        ]
      }
      const bundleExecInner = decodeBundleExecInner(innerHead, innerArgs, segment)
      if (bundleExecInner) {
        return bundleExecInner
      }
    }
    return null
  }

  if ((head === 'ruby' || head === 'yarn') && args.length >= 1 && isMetadataOnlyArgv(args)) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.runtime_metadata'])]
  }

  if (head === 'make' && args.includes('-n')) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.make_dry_run'])]
  }

  const base = executableBaseName(head)
  if ((base === 'rails' || base === 'rake') && railsReadOnlySubcommand(args)) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.rails_read_only'])]
  }

  return null
}
