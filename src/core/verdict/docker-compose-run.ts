import path from 'node:path'

import type { ShellToken } from '../shell-tokenizer.js'
import { decodeRecursiveInvocation, shellTokensFromValues } from './recursive-invocation.js'

type OptionArity = 0 | 1
type WordToken = Extract<ShellToken, { kind: 'word' }>

const COMPOSE_GLOBAL_OPTIONS = new Map<string, OptionArity>([
  ['--all-resources', 0],
  ['--ansi', 1],
  ['--compatibility', 0],
  ['--dry-run', 0],
  ['--env-file', 1],
  ['-f', 1],
  ['--file', 1],
  ['--parallel', 1],
  ['--profile', 1],
  ['--progress', 1],
  ['--project-directory', 1],
  ['-p', 1],
  ['--project-name', 1],
])

const COMPOSE_RUN_OPTIONS = new Map<string, OptionArity>([
  ['--build', 0],
  ['--cap-add', 1],
  ['--cap-drop', 1],
  ['-d', 0],
  ['--detach', 0],
  ['--entrypoint', 1],
  ['-e', 1],
  ['--env', 1],
  ['--env-from-file', 1],
  ['-i', 0],
  ['--interactive', 0],
  ['-l', 1],
  ['--label', 1],
  ['--name', 1],
  ['--no-deps', 0],
  ['-T', 0],
  ['--no-tty', 0],
  ['-p', 1],
  ['--publish', 1],
  ['--pull', 1],
  ['-q', 0],
  ['--quiet', 0],
  ['--quiet-build', 0],
  ['--quiet-pull', 0],
  ['--remove-orphans', 0],
  ['--rm', 0],
  ['-P', 0],
  ['--service-ports', 0],
  ['--use-aliases', 0],
  ['-u', 1],
  ['--user', 1],
  ['-v', 1],
  ['--volume', 1],
  ['-w', 1],
  ['--workdir', 1],
])

export type DockerComposeRunInvocation =
  | { kind: 'recursive'; service: string; interpreter: string; script: string }
  | { kind: 'dynamic'; service: string; signal: string }
  | { kind: 'none' }
  | { kind: 'indeterminate'; signal: 'shell.compose_argv_indeterminate' }

type OptionParseResult = { kind: 'ok'; index: number } | { kind: 'indeterminate' }

function parseOptions(
  words: readonly WordToken[],
  start: number,
  options: ReadonlyMap<string, OptionArity>,
): OptionParseResult {
  let index = start
  while (index < words.length) {
    const value = words[index]?.value ?? ''
    if (value === '--') return { kind: 'ok', index: index + 1 }
    if (!value.startsWith('-') || value === '-') return { kind: 'ok', index }

    const equalsIndex = value.indexOf('=')
    const name = equalsIndex === -1 ? value : value.slice(0, equalsIndex)
    const arity = options.get(name)
    if (arity === undefined) return { kind: 'indeterminate' }
    if (equalsIndex !== -1) {
      if (!value.startsWith('--') || arity !== 1 || equalsIndex === value.length - 1) {
        return { kind: 'indeterminate' }
      }
      index += 1
      continue
    }
    if (arity === 1) {
      if (!words[index + 1]) return { kind: 'indeterminate' }
      index += 2
      continue
    }
    index += 1
  }
  return { kind: 'ok', index }
}

export function decodeDockerComposeRun(tokens: readonly ShellToken[]): DockerComposeRunInvocation {
  if (tokens.some((token) => token.kind === 'operator')) return { kind: 'none' }
  const words = tokens.filter((token): token is WordToken => token.kind === 'word')
  const head = path.basename(words[0]?.value ?? '')
  let index: number
  if (head === 'docker-compose') {
    index = 1
  } else if (head === 'docker' && words[1]?.value === 'compose') {
    index = 2
  } else {
    return { kind: 'none' }
  }

  const globalOptions = parseOptions(words, index, COMPOSE_GLOBAL_OPTIONS)
  if (globalOptions.kind === 'indeterminate') {
    return { kind: 'indeterminate', signal: 'shell.compose_argv_indeterminate' }
  }
  index = globalOptions.index
  if (words[index]?.value !== 'run') return { kind: 'none' }

  const runOptions = parseOptions(words, index + 1, COMPOSE_RUN_OPTIONS)
  if (runOptions.kind === 'indeterminate') {
    return { kind: 'indeterminate', signal: 'shell.compose_argv_indeterminate' }
  }
  index = runOptions.index
  const service = words[index]?.value
  if (!service) return { kind: 'indeterminate', signal: 'shell.compose_argv_indeterminate' }

  const command = words.slice(index + 1)
  if (command.length === 0) return { kind: 'none' }
  const recursive = decodeRecursiveInvocation(command)
  if (recursive.kind === 'static') {
    return {
      kind: 'recursive',
      service,
      interpreter: recursive.interpreter,
      script: recursive.script,
    }
  }
  if (recursive.kind === 'dynamic') return { kind: 'dynamic', service, signal: recursive.signal }
  if (recursive.kind === 'indeterminate') {
    return { kind: 'indeterminate', signal: 'shell.compose_argv_indeterminate' }
  }
  return { kind: 'none' }
}

export function decodeDockerComposeRunValues(
  values: readonly string[],
): DockerComposeRunInvocation {
  return decodeDockerComposeRun(shellTokensFromValues(values, { detectExpansion: false }))
}
