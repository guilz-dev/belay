export function matchesSensitivePath(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replaceAll('\\', '/')
  const segments = normalized.split('/')
  const baseName = segments.at(-1) ?? normalized

  for (const pattern of patterns) {
    const normalizedPattern = pattern.replaceAll('\\', '/')

    if (normalizedPattern.includes('**')) {
      const parts = normalizedPattern.split('**').map((part) => part.replace(/^\/+|\/+$/g, ''))
      const prefix = parts[0]?.replace(/\/+$/, '') ?? ''
      const suffix = parts[1]?.replace(/^\/+/, '') ?? ''
      if (prefix && !normalized.startsWith(prefix)) {
        continue
      }
      if (suffix && !normalized.includes(suffix)) {
        continue
      }
      if (prefix || suffix) {
        return true
      }
    }

    if (normalizedPattern.includes('*')) {
      const regex = new RegExp(
        `^${normalizedPattern.replaceAll('.', '\\.').replaceAll('*', '.*')}$`,
      )
      if (regex.test(normalized) || regex.test(baseName)) {
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
