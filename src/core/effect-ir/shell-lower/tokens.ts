import path from 'node:path'

import { isFdDuplication, isRedirectOperator, type ShellToken } from '../../shell-tokenizer.js'

export const ENV_PREFIX_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'])
export const METADATA_ONLY_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h'])

export interface EnvironmentExtraction {
  env: Readonly<Record<string, string | undefined>>
  commandTokens?: string[]
  malformed: boolean
  changedNames: ReadonlySet<string>
}

export function extractEnvironment(
  tokens: string[],
  inherited: Readonly<Record<string, string | undefined>> | undefined,
): EnvironmentExtraction {
  const env: Record<string, string | undefined> = { ...inherited }
  const changedNames = new Set<string>()
  if (tokens[0] === 'env') {
    let index = 1
    let malformed = false
    while (index < tokens.length) {
      const option = tokens[index] ?? ''
      if (option === '-u' || option === '--unset') {
        const name = tokens[index + 1] ?? ''
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          malformed = true
          index += 1
          break
        }
        delete env[name]
        changedNames.add(name)
        index += 2
        continue
      }
      if (option.startsWith('--unset=')) {
        const name = option.slice('--unset='.length)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          malformed = true
          index += 1
          break
        }
        delete env[name]
        changedNames.add(name)
        index += 1
        continue
      }
      if (option === '-i' || option === '--ignore-environment') {
        for (const name of Object.keys(env)) {
          delete env[name]
        }
        changedNames.add('*')
        index += 1
        continue
      }
      if (option === '--') {
        index += 1
        break
      }
      if (option.startsWith('-')) {
        malformed = true
        index += 1
        break
      }
      break
    }
    while (index < tokens.length) {
      const token = tokens[index] ?? ''
      const match = ENV_PREFIX_PATTERN.exec(token)
      if (!match) {
        break
      }
      const [, name, value] = match
      if (name) {
        env[name] = expandKnownVariables(value ?? '', env)
        changedNames.add(name)
      }
      index += 1
    }
    const commandTokens = tokens.slice(index)
    return {
      env,
      commandTokens,
      malformed: malformed || commandTokens.length === 0,
      changedNames,
    }
  }
  for (const token of tokens) {
    const match = ENV_PREFIX_PATTERN.exec(token)
    if (!match) {
      break
    }
    const [, name, value] = match
    if (name) {
      env[name] = expandKnownVariables(value ?? '', env)
      changedNames.add(name)
    }
  }
  return { env, malformed: false, changedNames }
}

export function expandKnownVariables(
  token: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return token.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (raw, a, b) => {
      const value = env[a ?? b]
      return value === undefined ? raw : value
    },
  )
}

export function stripRedirects(tokens: string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (isFdDuplication(token)) {
      continue
    }
    if (!isRedirectOperator(token)) {
      stripped.push(token)
      continue
    }
    index += 1
  }
  return stripped
}

export function stripStructuredRedirects(tokens: readonly ShellToken[]): ShellToken[] {
  const stripped: ShellToken[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    if (isFdDuplication(token.value)) {
      continue
    }
    if (!isRedirectOperator(token.value)) {
      stripped.push(token)
      continue
    }
    index += 1
  }
  return stripped
}

export function alignStructuredTokens(
  tokens: readonly ShellToken[],
  values: readonly string[],
): ShellToken[] {
  if (values.length === 0) return []
  for (let start = tokens.length - values.length; start >= 0; start -= 1) {
    const candidate = tokens.slice(start)
    if (
      candidate.length === values.length &&
      candidate.every((token, index) => token.value === values[index])
    ) {
      return candidate
    }
  }
  return []
}

export function resolvePathOperand(operand: string, cwd: string): string {
  if (operand === '~') {
    return process.env.HOME ?? operand
  }
  if (operand.startsWith('~/')) {
    return path.join(process.env.HOME ?? '~', operand.slice(2))
  }
  return path.resolve(cwd, operand)
}

export function isOptionToken(value: string): boolean {
  return value.startsWith('-') || value.startsWith('+')
}

export function isShellHead(head: string): boolean {
  return head === 'bash' || head === 'sh' || head === 'zsh' || head === 'dash' || head === 'fish'
}

export function pipeToShell(command: string): boolean {
  return /(?:^|[|;&]\s*)(?:bash|sh|zsh|dash|fish)(?:\s|$)/.test(command) && /\|/.test(command)
}

export function executableBaseName(head: string): string {
  return path.basename(head)
}

export function isMetadataOnlyArgv(argv: string[]): boolean {
  return argv.length > 0 && argv.every((token) => METADATA_ONLY_FLAGS.has(token))
}

export function databaseEndpoint(
  raw: string | undefined,
): { host: string; protocol: string; port?: number } | null {
  if (!raw || raw.includes('$')) {
    return null
  }
  try {
    const url = new URL(raw)
    if (!url.hostname || !url.protocol) {
      return null
    }
    return {
      host: url.hostname.toLowerCase(),
      protocol: url.protocol.slice(0, -1),
      ...(url.port ? { port: Number(url.port) } : {}),
    }
  } catch {
    return null
  }
}
