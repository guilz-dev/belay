const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)$/

export function tokenizeShell(input: string): string[] {
  const tokens: string[] = []
  let buffer = ''
  let quote: string | null = null
  let escaping = false

  const flush = () => {
    if (buffer.length > 0) {
      tokens.push(buffer)
      buffer = ''
    }
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1] ?? ''
    if (escaping) {
      buffer += char
      escaping = false
      continue
    }
    if (char === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        buffer += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '&' && next === '&') {
      flush()
      tokens.push('&&')
      index += 1
      continue
    }
    if (char === '|' && next === '|') {
      flush()
      tokens.push('||')
      index += 1
      continue
    }
    if (char === '>' && next === '>') {
      flush()
      tokens.push('>>')
      index += 1
      continue
    }
    if (char === '|' || char === ';' || char === '>' || char === '<') {
      flush()
      tokens.push(char)
      continue
    }
    if (char === '\n' || char === '\r') {
      flush()
      tokens.push(';')
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    buffer += char
  }
  flush()
  return tokens
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
    if (token === '&&' || token === '||' || token === ';' || token === '|') {
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
    if (token === '>' || token === '>>' || token === '<') {
      const next = tokens[index + 1]
      if (next) {
        targets.push(next)
      }
    }
  }
  return targets
}
