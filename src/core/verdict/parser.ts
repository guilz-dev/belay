import path from 'node:path'
import {
  findCommandSubstitutions,
  findStructuralCommandSubstitutions,
} from '../shell-substitution.js'
import { commandKey, tokenizeShell } from '../shell-tokenizer.js'
import { detectUnparseableShell } from '../shell-unparseable.js'
import type { VerdictOpacity } from './types.js'

const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)$/
const MAX_WRAPPER_PEEL_DEPTH = 32

const TRANSPARENT_WRAPPERS = new Set([
  'sudo',
  'env',
  'nohup',
  'time',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
  'xargs',
])

const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish'])
const CODE_INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'osascript'])
const SCRIPT_FLAGS = new Set(['-c', '-lc', '-e', '--eval'])
const INTERPRETER_SCRIPT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.py',
  '.rb',
  '.pl',
  '.sh',
])

export interface ParsedSegment {
  tokens: string[]
  head: string
  key: string
  normalized: string
}

export function normalizeHead(token: string): string {
  const base = path.basename(token)
  if (base && base !== '.' && base !== '..') {
    return base
  }
  return token
}

export function peelTransparentWrappers(tokens: string[]): {
  tokens: string[]
  xargsStdinOpaque: boolean
  opaque: boolean
} {
  let current = [...tokens]
  let xargsStdinOpaque = false
  let peelDepth = 0

  while (current.length > 0) {
    if (peelDepth >= MAX_WRAPPER_PEEL_DEPTH) {
      return { tokens: current, xargsStdinOpaque: false, opaque: true }
    }
    peelDepth += 1
    while (current.length > 0 && ENV_PREFIX_PATTERN.test(current[0] ?? '')) {
      current.shift()
    }
    if (current.length === 0) {
      break
    }

    const head = normalizeHead(current[0] ?? '')
    if (head === 'sudo') {
      const wrapper = peelSudoWrapper(current)
      if (wrapper.kind === 'opaque') {
        return { tokens: current, xargsStdinOpaque: false, opaque: true }
      }
      current = wrapper.tokens
      continue
    }
    if (head === 'command' || head === 'builtin' || head === 'exec') {
      const wrapper = peelShellInvocationWrapper(head, current)
      if (wrapper.kind === 'opaque') {
        return { tokens: current, xargsStdinOpaque: false, opaque: true }
      }
      if (wrapper.kind === 'preserve') {
        return { tokens: current, xargsStdinOpaque: false, opaque: false }
      }
      current = wrapper.tokens
      continue
    }
    if (!TRANSPARENT_WRAPPERS.has(head)) {
      break
    }

    if (head === 'xargs') {
      let index = 1
      while (index < current.length && current[index]?.startsWith('-')) {
        index += 1
      }
      const rest = current.slice(index)
      if (rest.length === 0) {
        xargsStdinOpaque = true
        return { tokens: [], xargsStdinOpaque: true, opaque: true }
      }
      current = rest
      continue
    }

    if (head === 'env') {
      let index = 1
      while (index < current.length) {
        const token = current[index] ?? ''
        if (ENV_PREFIX_PATTERN.test(token) || token.startsWith('-')) {
          index += 1
          continue
        }
        break
      }
      current = current.slice(index)
      continue
    }

    current = current.slice(1)
  }

  return { tokens: current, xargsStdinOpaque, opaque: false }
}

type ShellInvocationWrapperResult =
  | { kind: 'peeled'; tokens: string[] }
  | { kind: 'preserve' }
  | { kind: 'opaque' }

function peelSudoWrapper(
  tokens: string[],
): Extract<ShellInvocationWrapperResult, { kind: 'peeled' | 'opaque' }> {
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (token === '--') {
      index += 1
      break
    }
    if (!token.startsWith('-') || token === '-') {
      break
    }
    if (token === '-n' || token === '--non-interactive') {
      index += 1
      continue
    }
    if (token === '-u' || token === '-g' || token === '--user' || token === '--group') {
      if (!tokens[index + 1] || tokens[index + 1] === '--') {
        return { kind: 'opaque' }
      }
      index += 2
      continue
    }
    if ((token.startsWith('-u') || token.startsWith('-g')) && token.length > 2) {
      index += 1
      continue
    }
    if (
      (token.startsWith('--user=') || token.startsWith('--group=')) &&
      token.slice(token.indexOf('=') + 1).length > 0
    ) {
      index += 1
      continue
    }
    return { kind: 'opaque' }
  }
  return index < tokens.length
    ? { kind: 'peeled', tokens: tokens.slice(index) }
    : { kind: 'opaque' }
}

function peelShellInvocationWrapper(
  head: 'command' | 'builtin' | 'exec',
  tokens: string[],
): ShellInvocationWrapperResult {
  switch (head) {
    case 'command':
      return peelCommandWrapper(tokens)
    case 'builtin':
      return peelBuiltinWrapper(tokens)
    case 'exec':
      return peelExecWrapper(tokens)
  }
}

function peelCommandWrapper(tokens: string[]): ShellInvocationWrapperResult {
  let index = 1
  let inspection = false
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (token === '--') {
      index += 1
      break
    }
    if (!token.startsWith('-') || token === '-') {
      break
    }
    const flags = token.slice(1)
    if (!flags || ![...flags].every((flag) => flag === 'p' || flag === 'v' || flag === 'V')) {
      return { kind: 'opaque' }
    }
    inspection ||= flags.includes('v') || flags.includes('V')
    index += 1
  }
  if (inspection) {
    return { kind: 'preserve' }
  }
  return index < tokens.length
    ? { kind: 'peeled', tokens: tokens.slice(index) }
    : { kind: 'opaque' }
}

function peelBuiltinWrapper(tokens: string[]): ShellInvocationWrapperResult {
  const first = tokens[1]
  if (first === '--') {
    return tokens.length > 2 ? { kind: 'peeled', tokens: tokens.slice(2) } : { kind: 'opaque' }
  }
  if (!first || first.startsWith('-')) {
    return { kind: 'opaque' }
  }
  return { kind: 'peeled', tokens: tokens.slice(1) }
}

function peelExecWrapper(tokens: string[]): ShellInvocationWrapperResult {
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (token === '--') {
      index += 1
      break
    }
    if (!token.startsWith('-') || token === '-') {
      break
    }
    if (token === '-a') {
      if (!tokens[index + 1]) {
        return { kind: 'opaque' }
      }
      index += 2
      continue
    }
    if (token.startsWith('-a') && token.length > 2) {
      index += 1
      continue
    }
    if (![...token.slice(1)].every((flag) => flag === 'c' || flag === 'l')) {
      return { kind: 'opaque' }
    }
    index += 1
  }
  return index < tokens.length
    ? { kind: 'peeled', tokens: tokens.slice(index) }
    : { kind: 'opaque' }
}

export function isVariableIndirectHead(head: string): boolean {
  return head.startsWith('$')
}

export function extractEvalBody(tokens: string[]): string | null {
  const head = normalizeHead(tokens[0] ?? '')
  if (head !== 'eval') {
    return null
  }
  const body = tokens.slice(1).join(' ').trim()
  return body || null
}

export function extractRecursiveScript(tokens: string[]): string | null {
  const { tokens: filtered, opaque } = peelTransparentWrappers(tokens)
  if (opaque) {
    return null
  }
  const head = normalizeHead(filtered[0] ?? '')
  const second = filtered[1] ?? ''

  if (head === 'eval') {
    const body = filtered.slice(1).join(' ').trim()
    return body || null
  }

  if (SHELL_INTERPRETERS.has(head) || CODE_INTERPRETERS.has(head)) {
    const flagIndex = filtered.findIndex((token) => SCRIPT_FLAGS.has(token))
    if (flagIndex !== -1) {
      const body = filtered
        .slice(flagIndex + 1)
        .join(' ')
        .replace(/^['"]|['"]$/g, '')
        .trim()
      return body || null
    }
  }

  if (head === 'bash' && (second === '-lc' || second === '-c')) {
    const body = filtered
      .slice(2)
      .join(' ')
      .replace(/^['"]|['"]$/g, '')
      .trim()
    return body || null
  }

  return null
}

/**
 * True when a recursive script is evaluated from a command argument rather
 * than expanded from a static launcher recipe. Callers use this semantic fact
 * to preserve fail-closed policy for dynamic evaluation.
 */
export function isDynamicRecursiveEvaluation(tokens: string[]): boolean {
  const { tokens: filtered, opaque } = peelTransparentWrappers(tokens)
  if (opaque) {
    return false
  }
  const head = normalizeHead(filtered[0] ?? '')
  if (head === 'eval') {
    return true
  }
  return (
    (SHELL_INTERPRETERS.has(head) || CODE_INTERPRETERS.has(head)) &&
    filtered.some((token) => SCRIPT_FLAGS.has(token))
  )
}

export function isCommandInspection(tokens: string[]): boolean {
  return (
    normalizeHead(tokens[0] ?? '') === 'command' && peelCommandWrapper(tokens).kind === 'preserve'
  )
}

export function isBareInterpreter(tokens: string[]): boolean {
  const { tokens: peeled, xargsStdinOpaque, opaque } = peelTransparentWrappers(tokens)
  if (xargsStdinOpaque || opaque) {
    return true
  }
  if (peeled.length === 0) {
    return false
  }
  const head = normalizeHead(peeled[0] ?? '')
  if (!SHELL_INTERPRETERS.has(head) && !CODE_INTERPRETERS.has(head)) {
    return false
  }
  const hasScriptFlag = peeled.some((token) => SCRIPT_FLAGS.has(token))
  if (hasScriptFlag) {
    return false
  }
  const args = peeled.slice(1)
  if (args.length === 0) {
    return true
  }
  if (args.every((token) => token.startsWith('-'))) {
    return false
  }
  const scriptArg = args.find((token) => !token.startsWith('-'))
  if (scriptArg && INTERPRETER_SCRIPT_EXTENSIONS.has(path.extname(scriptArg))) {
    return false
  }
  if (scriptArg) {
    return false
  }
  return true
}

export function splitTopLevelSegments(command: string): string[] {
  const tokens = tokenizeShell(command)
  const segments: string[] = []
  let current: string[] = []

  const flush = () => {
    if (current.length > 0) {
      segments.push(current.join(' '))
      current = []
    }
  }

  for (const token of tokens) {
    if (
      token === '&&' ||
      token === '||' ||
      token === ';' ||
      token === '|' ||
      token === '&' ||
      token === '|&'
    ) {
      flush()
      continue
    }
    current.push(token)
  }
  flush()
  return segments.filter((segment) => segment.trim().length > 0)
}

export function splitStructuralShellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  type ShellFrame = {
    quote: "'" | '"' | null
    escaping: boolean
    backtick: boolean
  }
  const outer: ShellFrame = { quote: null, escaping: false, backtick: false }
  const substitutions: ShellFrame[] = []

  const flush = () => {
    const segment = current.trim()
    if (segment) {
      segments.push(segment)
    }
    current = ''
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    const next = command[index + 1] ?? ''
    const frame = substitutions.at(-1) ?? outer
    if (frame.escaping) {
      current += char
      frame.escaping = false
      continue
    }
    if (char === '\\' && frame.quote !== "'") {
      current += char
      frame.escaping = true
      continue
    }
    if (frame.quote === "'") {
      current += char
      if (char === "'") {
        frame.quote = null
      }
      continue
    }
    if (char === '`') {
      frame.backtick = !frame.backtick
      current += char
      continue
    }
    if (frame.backtick) {
      current += char
      continue
    }
    if (char === '$' && next === '(') {
      current += '$('
      substitutions.push({ quote: null, escaping: false, backtick: false })
      index += 1
      continue
    }
    if (frame.quote) {
      current += char
      if (char === frame.quote) {
        frame.quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      frame.quote = char
      current += char
      continue
    }
    if (substitutions.length > 0 && char === ')') {
      substitutions.pop()
      current += char
      continue
    }
    if (substitutions.length > 0) {
      current += char
      continue
    }
    if (
      char === '&' &&
      (command[index - 1] === '>' || command[index - 1] === '<' || next === '>')
    ) {
      current += char
      continue
    }
    const twoCharacterOperator =
      (char === '&' && next === '&') ||
      (char === '|' && next === '|') ||
      (char === '|' && next === '&')
    if (twoCharacterOperator) {
      flush()
      index += 1
      continue
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '\r') {
      flush()
      continue
    }
    current += char
  }
  flush()
  return segments
}

export function parseSegment(command: string): ParsedSegment {
  const tokens = tokenizeShell(command)
  const { tokens: peeled } = peelTransparentWrappers(tokens)
  const normalizedTokens = peeled.map((token) => normalizeHead(token))
  const key = commandKey(peeled.map((token, index) => (index === 0 ? normalizeHead(token) : token)))
  return {
    tokens: peeled,
    head: normalizeHead(peeled[0] ?? ''),
    key,
    normalized: normalizedTokens.join(' ').trim(),
  }
}

export function segmentOpacity(command: string): VerdictOpacity {
  if (detectUnparseableShell(command)) {
    return 'unparseable'
  }
  const tokens = tokenizeShell(command)
  const { xargsStdinOpaque, opaque } = peelTransparentWrappers(tokens)
  if (xargsStdinOpaque || opaque) {
    return 'opaque'
  }
  if (isBareInterpreter(tokens)) {
    return 'opaque'
  }
  const segment = parseSegment(command)
  if (isVariableIndirectHead(segment.head)) {
    return 'opaque'
  }
  if (extractRecursiveScript(tokens)) {
    return 'recursive'
  }
  return 'transparent'
}

export function substitutionInners(command: string): string[] {
  return findCommandSubstitutions(command)
}

export function structuralSubstitutionInners(command: string): string[] {
  return findStructuralCommandSubstitutions(command)
}

export function redactCommand(command: string): string {
  return command
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-[REDACTED]')
    .trim()
}
