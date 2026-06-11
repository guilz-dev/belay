/**
 * Detects shell constructs that agent-belay cannot reliably parse (R1).
 */
export function detectUnparseableShell(command: string): boolean {
  if (hasProcessSubstitution(command)) {
    return true
  }
  if (hasSubshell(command)) {
    return true
  }
  if (hasBraceGroup(command)) {
    return true
  }
  if (hasUnclosedQuote(command)) {
    return true
  }
  if (hasUnbalancedDollarParen(command)) {
    return true
  }
  return false
}

function hasProcessSubstitution(command: string): boolean {
  return /<\s*\(/.test(command)
}

function hasSubshell(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.startsWith('(')) {
    return true
  }
  return /(?:^|[;&|]\s*)\(/.test(trimmed)
}

function hasBraceGroup(command: string): boolean {
  const stripped = command.replace(/'[^']*'|"[^"]*"/g, ' ')
  return /\{\s*[^\s}]/.test(stripped) || /;\s*\}/.test(stripped)
}

function hasUnclosedQuote(command: string): boolean {
  let quote: string | null = null
  let escaping = false
  for (const char of command) {
    if (escaping) {
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
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    }
  }
  return quote !== null
}

function hasUnbalancedDollarParen(command: string): boolean {
  let depth = 0
  let inSingle = false
  let inDouble = false
  let escaping = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaping) {
      escaping = false
      continue
    }
    if (char === '\\' && (inSingle || inDouble)) {
      escaping = true
      continue
    }
    if (!inDouble && char === "'") {
      inSingle = !inSingle
      continue
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) {
      continue
    }
    if (char === '$' && command[index + 1] === '(') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')' && depth > 0) {
      depth -= 1
    }
  }
  return depth > 0
}
