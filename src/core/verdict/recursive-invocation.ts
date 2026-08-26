import path from 'node:path'

import type { ShellToken } from '../shell-tokenizer.js'

const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish'])
const PYTHON_INTERPRETERS = new Set(['python', 'python3'])
const SHELL_SHORT_OPTIONS = new Set(['c', 'l', 'e', 'x', 'u'])
const SHELL_NON_SCRIPT_SHORT_OPTIONS = new Set(['n'])
const SHELL_TERMINAL_OPTIONS = new Map<string, ReadonlySet<string>>([
  ['bash', new Set(['--help', '--version'])],
  ['zsh', new Set(['--version'])],
  ['fish', new Set(['-h', '--help', '-v', '--version'])],
])
const SHELL_VALUE_OPTIONS = new Set(['-O', '+O', '--init-file', '--rcfile'])
const NODE_TERMINAL_OPTIONS = new Set(['-h', '--help', '--help-all', '-v', '--version'])
const NODE_FILE_OPTIONS = new Set(['-c', '--check'])

interface SeparatedProfile {
  scriptOptions: ReadonlySet<string>
  terminalOptions: ReadonlySet<string>
  terminalValueOptions: ReadonlySet<string>
  flagOptions: ReadonlySet<string>
  valueOptions: ReadonlySet<string>
  attachedValuePrefixes: readonly string[]
}

const PYTHON_PROFILE: SeparatedProfile = {
  scriptOptions: new Set(['-c']),
  terminalOptions: new Set(['-h', '--help', '-V', '-VV', '--version']),
  terminalValueOptions: new Set(['-m']),
  flagOptions: new Set([
    '-b',
    '-bb',
    '-B',
    '-d',
    '-E',
    '-I',
    '-O',
    '-OO',
    '-P',
    '-q',
    '-s',
    '-S',
    '-u',
    '-v',
    '-x',
  ]),
  valueOptions: new Set(['-W', '-X']),
  attachedValuePrefixes: ['-W', '-X'],
}

const RUBY_PROFILE: SeparatedProfile = {
  scriptOptions: new Set(['-e']),
  terminalOptions: new Set(['-h', '--help', '-v', '--version', '--copyright']),
  terminalValueOptions: new Set([]),
  flagOptions: new Set(['-d', '--debug', '-w']),
  valueOptions: new Set(['-I']),
  attachedValuePrefixes: ['-I'],
}

const PERL_PROFILE: SeparatedProfile = {
  scriptOptions: new Set(['-e']),
  terminalOptions: new Set(['-h', '--help', '-v', '--version']),
  terminalValueOptions: new Set([]),
  flagOptions: new Set([]),
  valueOptions: new Set(['-I']),
  attachedValuePrefixes: ['-I'],
}

const OSASCRIPT_PROFILE: SeparatedProfile = {
  scriptOptions: new Set(['-e']),
  terminalOptions: new Set(['-h', '--help']),
  terminalValueOptions: new Set([]),
  flagOptions: new Set([]),
  valueOptions: new Set(['-l']),
  attachedValuePrefixes: [],
}

export type RecursiveInvocation =
  | { kind: 'static'; interpreter: string; script: string }
  | { kind: 'dynamic'; interpreter: string; signal: 'shell.script_expanded' }
  | { kind: 'none' }
  | {
      kind: 'indeterminate'
      interpreter: string
      signal: 'shell.interpreter_argv_incomplete' | 'shell.interpreter_option_unknown'
    }

type WordToken = Extract<ShellToken, { kind: 'word' }>

function normalizeInterpreter(value: string): string {
  return path.basename(value)
}

function scriptResult(interpreter: string, token: WordToken | undefined): RecursiveInvocation {
  if (!token) {
    return { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_argv_incomplete' }
  }
  if (token.parts.some((part) => part.hasExpansion)) {
    return { kind: 'dynamic', interpreter, signal: 'shell.script_expanded' }
  }
  return { kind: 'static', interpreter, script: token.value }
}

function decodeShell(words: WordToken[], interpreter: string): RecursiveInvocation {
  for (let index = 1; index < words.length; index += 1) {
    const option = words[index]?.value ?? ''
    if (option === '--') return { kind: 'none' }
    if (SHELL_TERMINAL_OPTIONS.get(interpreter)?.has(option)) return { kind: 'none' }
    if (interpreter === 'bash' && SHELL_VALUE_OPTIONS.has(option)) {
      const operand = words[index + 1]?.value
      if (!operand || operand.startsWith('-')) {
        return { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
      }
      index += 1
      continue
    }
    if (!option.startsWith('-') || option === '-') return { kind: 'none' }
    const flags = [...option.slice(1)]
    if (flags.length === 0) {
      return { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
    }
    if (flags.every((flag) => SHELL_SHORT_OPTIONS.has(flag))) {
      if (!flags.includes('c')) continue
      return scriptResult(interpreter, words[index + 1])
    }
    if (
      flags.every(
        (flag) => SHELL_SHORT_OPTIONS.has(flag) || SHELL_NON_SCRIPT_SHORT_OPTIONS.has(flag),
      ) &&
      flags.some((flag) => SHELL_NON_SCRIPT_SHORT_OPTIONS.has(flag))
    ) {
      return { kind: 'none' }
    }
    return { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
  }
  return { kind: 'none' }
}

function decodeSeparated(
  words: WordToken[],
  interpreter: string,
  profile: SeparatedProfile,
): RecursiveInvocation {
  for (let index = 1; index < words.length; index += 1) {
    const option = words[index]?.value ?? ''
    if (option === '--' || !option.startsWith('-') || option === '-') return { kind: 'none' }
    if (profile.scriptOptions.has(option)) {
      return scriptResult(interpreter, words[index + 1])
    }
    if (profile.terminalOptions.has(option)) return { kind: 'none' }
    if (profile.terminalValueOptions.has(option)) {
      const operand = words[index + 1]?.value
      if (!operand || operand.startsWith('-')) {
        return { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
      }
      return { kind: 'none' }
    }
    if (profile.flagOptions.has(option)) {
      continue
    }
    if (profile.valueOptions.has(option)) {
      const operand = words[index + 1]?.value
      if (!operand || operand.startsWith('-')) {
        return { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
      }
      index += 1
      continue
    }
    if (
      profile.attachedValuePrefixes.some(
        (prefix) => option.startsWith(prefix) && option.length > prefix.length,
      )
    ) {
      continue
    }
    return { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
  }
  return { kind: 'none' }
}

function decodeNode(words: WordToken[], interpreter: string): RecursiveInvocation {
  const option = words[1]?.value ?? ''
  if (option === '--' || !option.startsWith('-') || option === '-') return { kind: 'none' }
  if (option === '-e' || option === '--eval') {
    return scriptResult(interpreter, words[2])
  }
  if (option.startsWith('--eval=')) {
    const script = option.slice('--eval='.length)
    if (words[1]?.parts.some((part) => part.hasExpansion)) {
      return { kind: 'dynamic', interpreter, signal: 'shell.script_expanded' }
    }
    return { kind: 'static', interpreter, script }
  }
  if (NODE_TERMINAL_OPTIONS.has(option)) return { kind: 'none' }
  if (NODE_FILE_OPTIONS.has(option)) return { kind: 'none' }
  return { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
}

function decodeEval(words: WordToken[]): RecursiveInvocation {
  const arguments_ = words.slice(1)
  if (arguments_.length === 0) return { kind: 'none' }
  if (arguments_.some((word) => word.parts.some((part) => part.hasExpansion))) {
    return { kind: 'dynamic', interpreter: 'eval', signal: 'shell.script_expanded' }
  }
  return {
    kind: 'static',
    interpreter: 'eval',
    script: arguments_.map((word) => word.value).join(' '),
  }
}

export function decodeRecursiveInvocation(tokens: readonly ShellToken[]): RecursiveInvocation {
  if (tokens.some((token) => token.kind === 'operator')) return { kind: 'none' }
  const words = tokens.filter((token): token is WordToken => token.kind === 'word')
  const interpreter = normalizeInterpreter(words[0]?.value ?? '')
  if (!interpreter) return { kind: 'none' }
  if (interpreter === 'eval') return decodeEval(words)
  if (SHELL_INTERPRETERS.has(interpreter)) return decodeShell(words, interpreter)
  if (PYTHON_INTERPRETERS.has(interpreter)) {
    return decodeSeparated(words, interpreter, PYTHON_PROFILE)
  }
  if (interpreter === 'node') return decodeNode(words, interpreter)
  if (interpreter === 'ruby') return decodeSeparated(words, interpreter, RUBY_PROFILE)
  if (interpreter === 'perl') return decodeSeparated(words, interpreter, PERL_PROFILE)
  if (interpreter === 'osascript') return decodeSeparated(words, interpreter, OSASCRIPT_PROFILE)
  return { kind: 'none' }
}

export function shellTokensFromValues(
  values: readonly string[],
  options: { detectExpansion?: boolean } = {},
): ShellToken[] {
  let offset = 0
  return values.map((value) => {
    const start = offset
    const end = start + value.length
    offset = end + 1
    return {
      kind: 'word',
      value,
      raw: value,
      start,
      end,
      parts: [
        {
          value,
          raw: value,
          start,
          end,
          quote: 'unquoted',
          hasExpansion:
            options.detectExpansion !== false && (value.includes('$') || value.includes('`')),
        },
      ],
    }
  })
}
