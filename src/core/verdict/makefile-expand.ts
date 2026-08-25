const MAX_EXPAND_DEPTH = 16

export function parseMakefileVariables(content: string): Map<string, string> {
  const variables = new Map<string, string>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:?]?=\s*(.+)$/.exec(trimmed)
    if (!match) {
      continue
    }
    variables.set(match[1] ?? '', (match[2] ?? '').trim())
  }
  return variables
}

export function parsePhonyTargets(content: string): Set<string> {
  const phony = new Set<string>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    const match = /^\.PHONY:\s*(.+)$/.exec(trimmed)
    if (!match) {
      continue
    }
    for (const token of (match[1] ?? '').split(/\s+/)) {
      if (token) {
        phony.add(token)
      }
    }
  }
  return phony
}

export function normalizeMakeRecipeLine(line: string): string {
  let normalized = line.trim()
  while (normalized.startsWith('@') || normalized.startsWith('-') || normalized.startsWith('+')) {
    normalized = normalized.slice(1).trimStart()
  }
  return normalized
}

export function expandMakeExpression(
  expression: string,
  cliVars: Readonly<Record<string, string>>,
  makefileVars: ReadonlyMap<string, string>,
): string | null {
  if (/\$\(\s*shell\b/i.test(expression) || expression.includes('$$')) {
    return null
  }
  try {
    const expanded = expandMakeValue(expression, cliVars, makefileVars, 0)
    if (expanded === null || /\$\(/.test(expanded) || /\$\{/.test(expanded)) {
      return null
    }
    return expanded
  } catch {
    return null
  }
}

function expandMakeValue(
  expression: string,
  cliVars: Readonly<Record<string, string>>,
  makefileVars: ReadonlyMap<string, string>,
  depth: number,
): string | null {
  if (depth > MAX_EXPAND_DEPTH) {
    return null
  }

  let value = expression.trim()
  let changed = true
  let iterations = 0
  while (changed && iterations < MAX_EXPAND_DEPTH) {
    changed = false
    iterations += 1

    const orMatch = value.match(/\$\(\s*or\s+([^()]*(?:\([^)]*\)[^()]*)*)\)/)
    if (orMatch) {
      const [fullMatch, inner] = orMatch
      const parts = splitMakeFunctionArgs(inner ?? '')
      let selected: string | null = null
      for (const part of parts) {
        const expanded = expandMakeValue(part.trim(), cliVars, makefileVars, depth + 1)
        if (expanded !== null && expanded.trim() !== '') {
          selected = expanded
          break
        }
      }
      if (selected === null) {
        const fallback = parts.at(-1)?.trim()
        selected =
          fallback === undefined ? '' : expandMakeValue(fallback, cliVars, makefileVars, depth + 1)
      }
      if (selected === null) {
        return null
      }
      value = value.replace(fullMatch, selected)
      changed = true
      continue
    }

    const varMatch = value.match(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/)
    if (varMatch) {
      const [fullMatch, name] = varMatch
      const resolved = resolveMakeVariable(name ?? '', cliVars, makefileVars, depth + 1)
      if (resolved === null) {
        return null
      }
      value = value.replace(fullMatch, resolved)
      changed = true
      continue
    }

    const bracedMatch = value.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/)
    if (bracedMatch) {
      const [fullMatch, name] = bracedMatch
      const resolved =
        name === 'PWD' ? '.' : resolveMakeVariable(name ?? '', cliVars, makefileVars, depth + 1)
      if (resolved === null) {
        return null
      }
      value = value.replace(fullMatch, resolved)
      changed = true
      continue
    }

    break
  }

  return value
}

function resolveMakeVariable(
  name: string,
  cliVars: Readonly<Record<string, string>>,
  makefileVars: ReadonlyMap<string, string>,
  depth: number,
): string | null {
  if (Object.hasOwn(cliVars, name)) {
    return cliVars[name] ?? ''
  }
  const definition = makefileVars.get(name)
  if (definition === undefined) {
    return null
  }
  return expandMakeValue(definition, cliVars, makefileVars, depth)
}

function splitMakeFunctionArgs(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  for (const char of input) {
    if (char === '(') {
      depth += 1
      current += char
      continue
    }
    if (char === ')') {
      depth -= 1
      current += char
      continue
    }
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) {
    parts.push(current.trim())
  }
  return parts
}
