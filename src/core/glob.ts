export function matchesSensitivePath(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replaceAll('\\', '/')
  const baseName = normalized.split('/').pop() ?? normalized

  for (const pattern of patterns) {
    const normalizedPattern = pattern.replaceAll('\\', '/')
    if (normalizedPattern.includes('**')) {
      const suffix = normalizedPattern.replace('**/', '')
      if (normalized.includes(suffix) || normalized.endsWith(suffix)) {
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
    }
    if (normalized === normalizedPattern || baseName === normalizedPattern) {
      return true
    }
    if (normalized.endsWith(`/${normalizedPattern}`)) {
      return true
    }
  }
  return false
}
