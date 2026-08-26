const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)$/
const FD_DUPLICATION_PATTERN = /^\d+[<>]&(?:\d+|-)$/
const FD_REDIRECT_PATTERN = /^\d+(?:>>?|<)$/

function readDigits(input: string, index: number): string {
  let end = index
  while (end < input.length && /[0-9]/.test(input[end] ?? '')) {
    end += 1
  }
  return input.slice(index, end)
}

// This tokenizer only recognizes FD redirects when the digit run is immediately
// followed by `>` or `<` (for example `2>&1`, `3>file`, `12>>log`, `3<file`,
// `3<&1`). It does not try to recover bash's full word-boundary rules for cases
// like `foo12>>bar` or `foo12<bar`.
function readShellOperator(input: string, index: number): { token: string; length: number } | null {
  const char = input[index]
  const next = input[index + 1] ?? ''
  const digits = /[0-9]/.test(char) ? readDigits(input, index) : ''
  const digitsLength = digits.length
  const afterDigits = digitsLength > 0 ? (input[index + digitsLength] ?? '') : ''
  const afterDigitsNext = digitsLength > 0 ? (input[index + digitsLength + 1] ?? '') : ''

  if (char === '&' && next === '&') {
    return { token: '&&', length: 2 }
  }
  if (char === '|' && next === '|') {
    return { token: '||', length: 2 }
  }
  if (char === '|' && next === '&') {
    return { token: '|&', length: 2 }
  }
  if (char === '&' && next === '>') {
    return { token: '&>', length: 2 }
  }
  if (digitsLength > 0 && (afterDigits === '>' || afterDigits === '<')) {
    if (afterDigitsNext === '&') {
      let end = index + digitsLength + 2
      while (end < input.length && /[0-9-]/.test(input[end] ?? '')) {
        end += 1
      }
      if (end > index + digitsLength + 2) {
        return { token: input.slice(index, end), length: end - index }
      }
    }
    if (afterDigits === '>' && afterDigitsNext === '>') {
      return { token: `${digits}>>`, length: digitsLength + 2 }
    }
    return { token: `${digits}${afterDigits}`, length: digitsLength + 1 }
  }
  if (char === '>' && next === '>') {
    return { token: '>>', length: 2 }
  }
  if (char === '&') {
    return { token: '&', length: 1 }
  }
  if (char === '|' || char === ';' || char === '>' || char === '<') {
    return { token: char, length: 1 }
  }
  return null
}

export function isRedirectOperator(token: string): boolean {
  return (
    token === '>' ||
    token === '>>' ||
    token === '<' ||
    token === '&>' ||
    FD_REDIRECT_PATTERN.test(token)
  )
}

export function isFdDuplication(token: string): boolean {
  return FD_DUPLICATION_PATTERN.test(token)
}

export type ShellQuoteMode = 'unquoted' | 'single' | 'double'

export interface ShellWordPart {
  value: string
  raw: string
  start: number
  end: number
  quote: ShellQuoteMode
  hasExpansion: boolean
}

export type ShellToken =
  | {
      kind: 'word'
      value: string
      raw: string
      start: number
      end: number
      parts: ShellWordPart[]
    }
  | { kind: 'operator'; value: string; raw: string; start: number; end: number }

export interface ShellLexResult {
  tokens: ShellToken[]
  complete: boolean
}

export function lexShell(input: string): ShellLexResult {
  const tokens: ShellToken[] = []
  let value = ''
  let wordStart: number | null = null
  let parts: ShellWordPart[] = []
  let quote: Exclude<ShellQuoteMode, 'unquoted'> | null = null
  let quoteStart = -1
  let quoteHadContent = false
  let complete = true

  const startWord = (index: number) => {
    wordStart ??= index
  }
  const append = (
    decoded: string,
    start: number,
    end: number,
    mode: ShellQuoteMode,
    hasExpansion: boolean,
  ) => {
    startWord(start)
    value += decoded
    const previous = parts.at(-1)
    if (
      previous &&
      previous.quote === mode &&
      previous.hasExpansion === hasExpansion &&
      previous.end === start
    ) {
      previous.value += decoded
      previous.raw += input.slice(start, end)
      previous.end = end
      return
    }
    parts.push({
      value: decoded,
      raw: input.slice(start, end),
      start,
      end,
      quote: mode,
      hasExpansion,
    })
  }
  const flushWord = (end: number) => {
    if (wordStart === null) return
    tokens.push({
      kind: 'word',
      value,
      raw: input.slice(wordStart, end),
      start: wordStart,
      end,
      parts,
    })
    value = ''
    wordStart = null
    parts = []
  }
  const pushOperator = (token: string, start: number, end: number) => {
    tokens.push({ kind: 'operator', value: token, raw: input.slice(start, end), start, end })
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ''

    if (quote === 'single') {
      if (char === "'") {
        if (!quoteHadContent) append('', quoteStart, index + 1, 'single', false)
        quote = null
      } else {
        append(char, index, index + 1, 'single', false)
        quoteHadContent = true
      }
      continue
    }

    if (quote === 'double') {
      if (char === '"') {
        if (!quoteHadContent) append('', quoteStart, index + 1, 'double', false)
        quote = null
        continue
      }
      if (char === '\\') {
        const next = input[index + 1]
        if (next === undefined) {
          append('\\', index, index + 1, 'double', false)
          complete = false
          continue
        }
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
          append(next === '\n' ? '' : next, index, index + 2, 'double', false)
          quoteHadContent = true
          index += 1
          continue
        }
        append('\\', index, index + 1, 'double', false)
        quoteHadContent = true
        continue
      }
      append(char, index, index + 1, 'double', char === '$' || char === '`')
      quoteHadContent = true
      continue
    }

    if (char === "'" || char === '"') {
      startWord(index)
      quote = char === "'" ? 'single' : 'double'
      quoteStart = index
      quoteHadContent = false
      continue
    }
    if (char === '\\') {
      const next = input[index + 1]
      if (next === undefined) {
        append('\\', index, index + 1, 'unquoted', false)
        complete = false
        continue
      }
      append(next, index, index + 2, 'unquoted', false)
      index += 1
      continue
    }
    const operator = readShellOperator(input, index)
    if (operator) {
      flushWord(index)
      pushOperator(operator.token, index, index + operator.length)
      index += operator.length - 1
      continue
    }
    if (char === '\n' || char === '\r') {
      flushWord(index)
      pushOperator(';', index, index + 1)
      continue
    }
    if (/\s/.test(char)) {
      flushWord(index)
      continue
    }
    append(char, index, index + 1, 'unquoted', char === '$' || char === '`')
  }

  if (quote !== null) complete = false
  flushWord(input.length)
  return { tokens, complete }
}

export function tokenizeShell(input: string): string[] {
  return lexShell(input).tokens.map((token) => token.value)
}

export function normalizeShellCommand(
  command: string,
  repoRoot: string,
  normalizeToken: (t: string, r: string) => string,
): string {
  const tokens = tokenizeShell(command)
  while (tokens.length > 0 && ENV_PREFIX_PATTERN.test(tokens[0] ?? '')) {
    tokens.shift()
  }
  const normalized = tokens.map((token) => normalizeToken(token, repoRoot))
  return normalized.join(' ').trim()
}

export function splitTopLevelSegments(tokens: string[]): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  for (const token of tokens) {
    if (
      token === '&&' ||
      token === '||' ||
      token === ';' ||
      token === '|' ||
      token === '&' ||
      token === '|&'
    ) {
      if (current.length > 0) {
        segments.push(current)
      }
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) {
    segments.push(current)
  }
  return segments
}

export function commandKey(tokens: string[]): string {
  const filtered = tokens.filter((token) => token !== 'sudo')
  const first = filtered[0] ?? ''
  const second = filtered[1] ?? ''
  if (
    (first === 'git' ||
      first === 'npm' ||
      first === 'pnpm' ||
      first === 'docker' ||
      first === 'terraform' ||
      first === 'fly' ||
      first === 'firebase') &&
    second
  ) {
    return `${first} ${second}`
  }
  return first
}

export function extractRedirectTargets(tokens: string[]): string[] {
  const targets: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (isFdDuplication(token)) {
      continue
    }
    if (isRedirectOperator(token)) {
      const next = tokens[index + 1]
      if (next) {
        targets.push(next)
      }
    }
  }
  return targets
}
