import path from 'node:path'

import type { ShellToken } from '../shell-tokenizer.js'

const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish'])
const PYTHON_INTERPRETERS = new Set(['python', 'python3'])
const EVAL_INTERPRETERS = new Set(['ruby', 'perl', 'osascript'])
const SHELL_SHORT_OPTIONS = new Set(['c', 'l', 'e', 'x', 'u'])

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
    if (!option.startsWith('-') || option === '-') return { kind: 'none' }
    const flags = [...option.slice(1)]
    if (flags.length === 0 || !flags.every((flag) => SHELL_SHORT_OPTIONS.has(flag))) {
      const laterScriptFlag = words.slice(index + 1).some((word) => {
        const laterFlags = [...word.value.slice(1)]
        return word.value.startsWith('-') && laterFlags.includes('c')
      })
      return laterScriptFlag
        ? { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
        : { kind: 'none' }
    }
    if (flags.includes('c')) return scriptResult(interpreter, words[index + 1])
  }
  return { kind: 'none' }
}

function decodeSeparated(
  words: WordToken[],
  interpreter: string,
  scriptOptions: ReadonlySet<string>,
): RecursiveInvocation {
  const option = words[1]?.value
  if (!option || option === '--' || !option.startsWith('-') || option === '-') {
    return { kind: 'none' }
  }
  if (scriptOptions.has(option)) return scriptResult(interpreter, words[2])
  return words.slice(2).some((word) => scriptOptions.has(word.value))
    ? { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
    : { kind: 'none' }
}

function decodeNode(words: WordToken[], interpreter: string): RecursiveInvocation {
  const option = words[1]?.value
  if (!option || option === '--' || !option.startsWith('-') || option === '-') {
    return { kind: 'none' }
  }
  if (option === '-e' || option === '--eval') return scriptResult(interpreter, words[2])
  if (option.startsWith('--eval=')) {
    const script = option.slice('--eval='.length)
    if (words[1]?.parts.some((part) => part.hasExpansion)) {
      return { kind: 'dynamic', interpreter, signal: 'shell.script_expanded' }
    }
    return { kind: 'static', interpreter, script }
  }
  const laterEval = words
    .slice(2)
    .some(
      (word) => word.value === '-e' || word.value === '--eval' || word.value.startsWith('--eval='),
    )
  return laterEval
    ? { kind: 'indeterminate', interpreter, signal: 'shell.interpreter_option_unknown' }
    : { kind: 'none' }
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
    return decodeSeparated(words, interpreter, new Set(['-c']))
  }
  if (interpreter === 'node') return decodeNode(words, interpreter)
  if (EVAL_INTERPRETERS.has(interpreter)) {
    return decodeSeparated(words, interpreter, new Set(['-e']))
  }
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
