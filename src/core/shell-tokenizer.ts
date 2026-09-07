const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)$/
const FD_DUPLICATION_PATTERN = /^\d+[<>]&(?:\d+|-)$/
const FD_REDIRECT_PATTERN = /^\d+(?:>>?|<)$/
const HEREDOC_OPERATOR_PATTERN = /^(?:\d+)?<<-?$/

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
  if (digitsLength > 0 && afterDigits === '<' && afterDigitsNext === '<') {
    const stripsTabs = input[index + digitsLength + 2] === '-'
    return {
      token: `${digits}<<${stripsTabs ? '-' : ''}`,
      length: digitsLength + (stripsTabs ? 3 : 2),
    }
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
  if (char === '<' && next === '<') {
    const stripsTabs = input[index + 2] === '-'
    return { token: stripsTabs ? '<<-' : '<<', length: stripsTabs ? 3 : 2 }
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
    HEREDOC_OPERATOR_PATTERN.test(token) ||
    FD_REDIRECT_PATTERN.test(token)
  )
}

export function isHeredocOperator(token: string): boolean {
  return HEREDOC_OPERATOR_PATTERN.test(token)
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

export interface ShellHeredoc {
  operator: {
    value: string
    start: number
    end: number
  }
  delimiter: {
    value: string
    raw: string
    quoted: boolean
    start: number
    end: number
  }
  body: {
    value: string
    start: number
    end: number
  }
  terminator: {
    start: number
    end: number
  }
  expands: boolean
  complete: boolean
}

export interface ShellLexResult {
  tokens: ShellToken[]
  complete: boolean
  syntaxComplete: boolean
  heredocs: ShellHeredoc[]
}

export function lexShell(input: string): ShellLexResult {
  const tokens: ShellToken[] = []
  const heredocs: ShellHeredoc[] = []
  let value = ''
  let wordStart: number | null = null
  let parts: ShellWordPart[] = []
  let quote: Exclude<ShellQuoteMode, 'unquoted'> | null = null
  let quoteStart = -1
  let quoteHadContent = false
  let syntaxComplete = true
  let heredocsComplete = true
  let awaitingHeredocOperator: Extract<ShellToken, { kind: 'operator' }> | null = null
  let pendingHeredocs: Array<{
    operator: Extract<ShellToken, { kind: 'operator' }>
    delimiter: Extract<ShellToken, { kind: 'word' }>
  }> = []
  type PendingHeredoc = (typeof pendingHeredocs)[number]

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
    const token: Extract<ShellToken, { kind: 'word' }> = {
      kind: 'word',
      value,
      raw: input.slice(wordStart, end),
      start: wordStart,
      end,
      parts,
    }
    tokens.push(token)
    if (awaitingHeredocOperator) {
      pendingHeredocs.push({ operator: awaitingHeredocOperator, delimiter: token })
      awaitingHeredocOperator = null
    }
    value = ''
    wordStart = null
    parts = []
  }
  const pushOperator = (token: string, start: number, end: number) => {
    const operator: Extract<ShellToken, { kind: 'operator' }> = {
      kind: 'operator',
      value: token,
      raw: input.slice(start, end),
      start,
      end,
    }
    tokens.push(operator)
    if (isHeredocOperator(token)) {
      if (awaitingHeredocOperator) {
        syntaxComplete = false
      }
      awaitingHeredocOperator = operator
    }
  }

  const appendHeredoc = (
    pending: PendingHeredoc,
    bodyStart: number,
    bodyEnd: number,
    terminatorStart: number,
    terminatorEnd: number,
    complete: boolean,
  ) => {
    const delimiter = pending.delimiter.value
    const quoted = pending.delimiter.raw !== delimiter
    heredocs.push({
      operator: {
        value: pending.operator.value,
        start: pending.operator.start,
        end: pending.operator.end,
      },
      delimiter: {
        value: delimiter,
        raw: pending.delimiter.raw,
        quoted,
        start: pending.delimiter.start,
        end: pending.delimiter.end,
      },
      body: {
        value: input.slice(bodyStart, bodyEnd),
        start: bodyStart,
        end: bodyEnd,
      },
      terminator: { start: terminatorStart, end: terminatorEnd },
      expands: !quoted,
      complete,
    })
  }

  const scanHeredocBodies = (bodyStart: number): number => {
    let cursor = bodyStart
    for (const pending of pendingHeredocs) {
      const delimiter = pending.delimiter.value
      const stripsTabs = pending.operator.value.endsWith('<<-')
      const currentBodyStart = cursor
      let found = false

      while (cursor < input.length) {
        const lineStart = cursor
        const newlineIndex = input.indexOf('\n', cursor)
        const lineEnd = newlineIndex === -1 ? input.length : newlineIndex
        const line = input.slice(lineStart, lineEnd).replace(/\r$/, '')
        const comparable = stripsTabs ? line.replace(/^\t+/, '') : line
        if (comparable === delimiter) {
          appendHeredoc(pending, currentBodyStart, lineStart, lineStart, lineEnd, true)
          cursor = newlineIndex === -1 ? input.length : newlineIndex + 1
          found = true
          break
        }
        if (newlineIndex === -1) {
          cursor = input.length
          break
        }
        cursor = newlineIndex + 1
      }

      if (!found) {
        appendHeredoc(pending, currentBodyStart, input.length, input.length, input.length, false)
        heredocsComplete = false
        cursor = input.length
        break
      }
    }
    pendingHeredocs = []
    return cursor
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ''
    const nextChar = input[index + 1] ?? ''

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
          syntaxComplete = false
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
        syntaxComplete = false
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
      if (awaitingHeredocOperator) {
        syntaxComplete = false
        awaitingHeredocOperator = null
      }
      if (pendingHeredocs.length > 0) {
        const nextIndex = char === '\r' && nextChar === '\n' ? index + 2 : index + 1
        const resumeIndex = scanHeredocBodies(nextIndex)
        index = resumeIndex - 1
      } else if (char === '\r' && nextChar === '\n') {
        index += 1
      }
      continue
    }
    if (/\s/.test(char)) {
      flushWord(index)
      continue
    }
    append(char, index, index + 1, 'unquoted', char === '$' || char === '`')
  }

  if (quote !== null) syntaxComplete = false
  flushWord(input.length)
  if (awaitingHeredocOperator) {
    syntaxComplete = false
  }
  if (pendingHeredocs.length > 0) {
    for (const pending of pendingHeredocs) {
      appendHeredoc(pending, input.length, input.length, input.length, input.length, false)
    }
    pendingHeredocs = []
    heredocsComplete = false
  }
  return {
    tokens,
    complete: syntaxComplete && heredocsComplete,
    syntaxComplete,
    heredocs,
  }
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
      if (isHeredocOperator(token)) {
        index += 1
        continue
      }
      const next = tokens[index + 1]
      if (next) {
        targets.push(next)
      }
    }
  }
  return targets
}
