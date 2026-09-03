import type { ShellEffectRequirement } from '../../shell-build.js'
import { processRequirement, unsupportedProcess } from '../requirement.js'
import { isOptionToken } from '../tokens.js'

export function decodeDockerComposeRun(
  head: string,
  args: string[],
  segment: string,
): ShellEffectRequirement[] | null {
  let composeArgs: string[] | null = null
  let command = head
  if (head === 'docker-compose') {
    composeArgs = args
  } else if (head === 'docker' && args[0] === 'compose') {
    composeArgs = args.slice(1)
    command = 'docker'
  }
  if (!composeArgs) {
    return null
  }
  if (composeArgs.includes('run')) {
    return [processRequirement(command, 'spawn', segment, ['process.docker_compose_run'])]
  }
  return unsupportedProcess(command, segment, 'process.docker_compose_grammar_incomplete')
}

export function validDockerInfo(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--help') {
      continue
    }
    if (arg === '--format' || arg === '-f') {
      if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
        return false
      }
      index += 1
      continue
    }
    if (arg.startsWith('--format=')) {
      if (arg.slice('--format='.length).length === 0) {
        return false
      }
      continue
    }
    return false
  }
  return true
}
