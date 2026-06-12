import path from 'node:path'
import { findCommandSubstitutions } from '../shell-substitution.js'
import { commandKey, tokenizeShell } from '../shell-tokenizer.js'
import { detectUnparseableShell } from '../shell-unparseable.js'
import type { VerdictOpacity } from './types.js'

const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)$/

const TRANSPARENT_WRAPPERS = new Set([
  'sudo',
  'env',
  'nohup',
  'time',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
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
} {
  let current = [...tokens]
  let xargsStdinOpaque = false

  while (current.length > 0) {
    while (current.length > 0 && ENV_PREFIX_PATTERN.test(current[0] ?? '')) {
      current.shift()
    }
    if (current.length === 0) {
      break
    }

    const head = normalizeHead(current[0] ?? '')
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
        return { tokens: [], xargsStdinOpaque: true }
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

  return { tokens: current, xargsStdinOpaque }
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
  const filtered = tokens.filter((token) => token !== 'sudo')
  const head = normalizeHead(filtered[0] ?? '')
  const second = filtered[1] ?? ''

  if (head === 'eval') {
    return extractEvalBody(tokens)
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

export function isBareInterpreter(tokens: string[]): boolean {
  const { tokens: peeled, xargsStdinOpaque } = peelTransparentWrappers(tokens)
  if (xargsStdinOpaque) {
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
  const scriptArg = peeled[1]
  if (scriptArg && INTERPRETER_SCRIPT_EXTENSIONS.has(path.extname(scriptArg))) {
    return false
  }
  if (scriptArg && !scriptArg.startsWith('-')) {
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
    if (token === '&&' || token === '||' || token === ';' || token === '|' || token === '&') {
      flush()
      continue
    }
    current.push(token)
  }
  flush()
  return segments.filter((segment) => segment.trim().length > 0)
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
  const { xargsStdinOpaque } = peelTransparentWrappers(tokens)
  if (xargsStdinOpaque) {
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

export function redactCommand(command: string): string {
  return command
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-[REDACTED]')
    .trim()
}
