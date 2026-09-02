import { escapeRegex } from './approval.js'

function globPatternToRegexSource(pattern: string): string {
  let result = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]!
    if (char === '*' && pattern[index + 1] === '*') {
      index += 2
      if (pattern[index] === '/') {
        result += '(?:.*/)?'
        index += 1
      } else {
        result += '.*'
      }
      continue
    }
    if (char === '*') {
      result += '[^/]*'
      index += 1
      continue
    }
    result += escapeRegex(char)
    index += 1
  }
  return result
}

function globPatternMatches(pattern: string, normalized: string, baseName: string): boolean {
  const regex = new RegExp(`^${globPatternToRegexSource(pattern)}$`)
  return regex.test(normalized) || regex.test(baseName)
}

export function matchesSensitivePath(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replaceAll('\\', '/')
  const segments = normalized.split('/')
  const baseName = segments.at(-1) ?? normalized

  for (const pattern of patterns) {
    const normalizedPattern = pattern.replaceAll('\\', '/')

    if (normalizedPattern.includes('*')) {
      if (globPatternMatches(normalizedPattern, normalized, baseName)) {
        return true
      }
      continue
    }

    if (normalized === normalizedPattern || baseName === normalizedPattern) {
      return true
    }
    if (normalized.endsWith(`/${normalizedPattern}`)) {
      return true
    }
    if (segments.includes(normalizedPattern)) {
      return true
    }
  }
  return false
}
