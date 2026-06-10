const MAX_SUBSTITUTION_DEPTH = 8

export { MAX_SUBSTITUTION_DEPTH }

/**
 * Finds inner commands for $(...) and backtick substitution, respecting escapes and nesting.
 */
export function findCommandSubstitutions(command: string): string[] {
  const results: string[] = []
  let index = 0

  while (index < command.length) {
    const char = command[index]
    if (char === '\\' && index + 1 < command.length) {
      index += 2
      continue
    }
    if (char === '`') {
      const end = findClosingBacktick(command, index + 1)
      if (end === -1) {
        break
      }
      const inner = command.slice(index + 1, end).trim()
      if (inner) {
        results.push(inner)
      }
      index = end + 1
      continue
    }
    if (char === '$' && command[index + 1] === '(') {
      const closed = extractBalancedParenContent(command, index + 2)
      if (!closed) {
        index += 1
        continue
      }
      const inner = closed.content.trim()
      if (inner) {
        results.push(inner)
      }
      index = closed.endIndex
      continue
    }
    index += 1
  }

  return results
}

function findClosingBacktick(command: string, start: number): number {
  let index = start
  while (index < command.length) {
    if (command[index] === '\\' && index + 1 < command.length) {
      index += 2
      continue
    }
    if (command[index] === '`') {
      return index
    }
    index += 1
  }
  return -1
}

function extractBalancedParenContent(
  command: string,
  start: number,
): { content: string; endIndex: number } | null {
  let depth = 1
  let index = start
  let inSingle = false
  let inDouble = false
  let escaping = false

  while (index < command.length && depth > 0) {
    const char = command[index]
    if (escaping) {
      escaping = false
      index += 1
      continue
    }
    if (char === '\\' && (inSingle || inDouble)) {
      escaping = true
      index += 1
      continue
    }
    if (!inDouble && char === "'") {
      inSingle = !inSingle
      index += 1
      continue
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble
      index += 1
      continue
    }
    if (!inSingle && !inDouble) {
      if (char === '(') {
        depth += 1
      } else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          return {
            content: command.slice(start, index),
            endIndex: index + 1,
          }
        }
      }
    }
    index += 1
  }

  return null
}
