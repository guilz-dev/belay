import path from 'node:path'

import { isCommandInspection } from '../../verdict/parser.js'
import type { ShellEffectRequirement } from '../shell-build.js'
import { decodeBelay } from './decoders/belay.js'
import {
  bashSyntaxTarget,
  decodeShellControlBuiltin,
  validFilesystemTest,
  validLsof,
  validPs,
} from './decoders/builtins.js'
import { decodeDockerComposeRun, validDockerInfo } from './decoders/docker.js'
import {
  decodeCopyMove,
  decodeRm,
  filesystemReadOperands,
  filesystemWriteOperands,
} from './decoders/filesystem.js'
import { decodePrisma } from './decoders/prisma.js'
import { decodeBundleExecInner, decodeRuby, decodeRuntimeMetadataProcess } from './decoders/ruby.js'
import { decodeGo, decodeNode, decodeRsync, decodeSed, decodeTsc } from './decoders/toolchain.js'
import {
  addSecretRead,
  addWriteEffects,
  processRequirement,
  requirement,
  unsupportedProcess,
} from './requirement.js'
import {
  ENV_PREFIX_PATTERN,
  isMetadataOnlyArgv,
  isShellHead,
  resolvePathOperand,
} from './tokens.js'

export function decodeProcessOrFilesystem(params: {
  tokens: string[]
  head: string
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  repoRoot: string
  segment: string
}): ShellEffectRequirement[] {
  const { tokens, head, env, cwd, repoRoot, segment } = params
  const args = tokens.slice(1)

  if (tokens.length > 0 && tokens.every((token) => ENV_PREFIX_PATTERN.test(token))) {
    return []
  }

  const shellControl = decodeShellControlBuiltin(head, args)
  if (shellControl) {
    return shellControl
  }

  if (isCommandInspection(tokens)) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.command_lookup'])]
  }
  if (head === 'lsof') {
    return validLsof(args)
      ? [processRequirement(head, 'inspect', segment, ['process.inspect.lsof'])]
      : unsupportedProcess(head, segment, 'process.lsof_grammar_incomplete')
  }
  if (head === 'ps') {
    return validPs(args)
      ? [processRequirement(head, 'inspect', segment, ['process.inspect.ps'])]
      : unsupportedProcess(head, segment, 'process.ps_grammar_incomplete')
  }
  if (head === 'test' || head === '[') {
    return validFilesystemTest(head, args)
      ? [processRequirement(head, 'inspect', segment, ['process.inspect.filesystem_test'])]
      : unsupportedProcess(head, segment, 'process.filesystem_test_grammar_incomplete')
  }
  if (head === 'docker') {
    if (args[0] === 'info') {
      return validDockerInfo(args.slice(1))
        ? [processRequirement(head, 'inspect', segment, ['process.inspect.docker_info'])]
        : unsupportedProcess(head, segment, 'process.docker_info_grammar_incomplete')
    }
    if (
      args[0] === 'compose' &&
      ['up', 'down', 'start', 'stop', 'restart', 'create', 'rm'].includes(args[1] ?? '')
    ) {
      return [processRequirement(head, 'spawn', segment, ['service.local_mutation'])]
    }
    if (
      args[0] === 'push' ||
      (args[0] === 'build' && args.includes('--push')) ||
      (args[0] === 'buildx' &&
        args[1] === 'build' &&
        (args.includes('--push') ||
          args.some(
            (arg) => arg.startsWith('--output=type=registry') || arg.startsWith('-o=type=registry'),
          )))
    ) {
      return [
        processRequirement(head, 'spawn', segment, ['tier0_external', 'docker.remote_mutation']),
        requirement(
          'network.connect',
          'network.connect',
          {
            kind: 'network',
            host: 'registry',
            protocol: 'container-registry',
            mode: 'mutate',
            payload: 'present',
          },
          segment,
          ['tier0_external', 'docker.remote_mutation'],
        ),
      ]
    }
    if (
      args[0] === 'run' ||
      args[0] === 'create' ||
      args[0] === 'pull' ||
      args[0] === 'build' ||
      (args[0] === 'buildx' && args[1] === 'build')
    ) {
      return [
        processRequirement(head, 'spawn', segment, ['process.docker_spawn']),
        requirement(
          'network.acquire',
          'network.connect',
          {
            kind: 'network',
            host: 'unknown',
            protocol: 'container-registry',
            mode: 'ambiguous',
            payload: 'none',
          },
          segment,
          ['docker.image_acquisition_possible'],
        ),
      ]
    }
    return [processRequirement(head, 'spawn', segment, ['process.docker_spawn'])]
  }
  if (isShellHead(head)) {
    const syntax = bashSyntaxTarget(args)
    if (syntax) {
      return [
        processRequirement(head, 'inspect', segment, ['process.inspect.shell_syntax']),
        requirement(
          'fs.read',
          'fs.read',
          { kind: 'path', path: path.resolve(cwd, syntax) },
          segment,
          ['shell.syntax_source_read'],
        ),
      ]
    }
    return unsupportedProcess(head, segment, 'process.shell_grammar_incomplete')
  }
  if (head === 'prisma') {
    return decodePrisma(args, env, repoRoot, segment)
  }
  const runtimeMetadata = decodeRuntimeMetadataProcess(head, args, segment)
  if (runtimeMetadata) {
    return runtimeMetadata
  }
  if (head === 'ruby') {
    return decodeRuby(args, cwd, repoRoot, segment)
  }
  if (head === 'rubocop' || head === 'rspec') {
    const decoded = decodeBundleExecInner(head, args, segment)
    if (decoded) {
      return decoded
    }
  }
  const dockerCompose = decodeDockerComposeRun(head, args, segment)
  if (dockerCompose) {
    return dockerCompose
  }
  if ((head === 'npm' || head === 'pnpm') && args.length === 1 && isMetadataOnlyArgv(args)) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.package_manager'])]
  }
  if (head === 'belay') {
    return decodeBelay(args, repoRoot, segment)
  }
  if (head === 'tsc') {
    return decodeTsc(args, cwd, segment)
  }
  if (head === 'go') {
    return decodeGo(args, segment)
  }
  if (head === 'rsync') {
    return decodeRsync(args, cwd, segment)
  }
  if (head === 'sed') {
    return decodeSed(args, cwd, segment)
  }
  if (head === 'base64' && args.length === 1 && ['-d', '-D', '--decode'].includes(args[0] ?? '')) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.base64_stdin'])]
  }
  if (head === 'node') {
    return decodeNode(args, cwd, segment)
  }
  if (head === 'vite' || head === 'vite-node') {
    return [processRequirement(head, 'spawn', segment, ['process.local_dev_spawn'])]
  }
  if (
    ((head === 'npm' || head === 'pnpm') && args[0] === 'publish') ||
    (head === 'terraform' && args[0] === 'apply')
  ) {
    return [
      processRequirement(head, 'spawn', segment, ['tier0_external']),
      requirement(
        'network.connect',
        'network.connect',
        {
          kind: 'network',
          host: 'control-plane',
          protocol: head,
          mode: 'mutate',
          payload: 'present',
        },
        segment,
        ['tier0_external'],
      ),
    ]
  }
  if (head === 'cd') {
    return []
  }
  if (head === 'cp' || head === 'mv') {
    return decodeCopyMove(head, args, cwd, segment)
  }
  if (head === 'rm') {
    return decodeRm(args, cwd, repoRoot, segment)
  }
  if (head === 'vitest' || head === 'eslint' || head === 'biome' || head === 'belay') {
    return [processRequirement(head, 'spawn', segment, ['process.known_local_spawn'])]
  }
  if (head === 'pwd' || head === 'which' || head === 'whoami') {
    return [processRequirement(head, 'inspect', segment, ['process.pure_inspection'])]
  }

  const readOperands = filesystemReadOperands(head, args)
  if (readOperands !== null) {
    const lowered = [processRequirement(head, 'inspect', segment, ['process.filesystem_inspect'])]
    for (const operand of readOperands) {
      const resolved = resolvePathOperand(operand, cwd)
      lowered.push(
        requirement('fs.read', 'fs.read', { kind: 'path', path: resolved }, segment, [
          'filesystem.read',
        ]),
      )
      addSecretRead(lowered, resolved, segment)
    }
    return lowered
  }

  const writeOperands = filesystemWriteOperands(head, args)
  if (writeOperands !== null) {
    const lowered = [processRequirement(head, 'spawn', segment, ['process.filesystem_mutation'])]
    for (const operand of writeOperands) {
      addWriteEffects(lowered, resolvePathOperand(operand, cwd), segment, ['filesystem.write'])
    }
    return lowered
  }

  if (head === 'printf' || head === 'echo' || head === 'true' || head === 'false' || head === ':') {
    return []
  }
  if (!head) {
    return [
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'shell.segment_empty',
      ]),
    ]
  }
  return unsupportedProcess(head, segment, 'process.grammar_unknown')
}
