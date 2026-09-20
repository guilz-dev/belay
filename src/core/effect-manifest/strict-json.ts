const MAX_JSON_DEPTH = 32

export type StrictJsonResult = { ok: true; value: unknown } | { ok: false }

/** Parse bounded authority JSON while rejecting duplicate keys and non-canonical strings. */
export function parseStrictJson(text: string): StrictJsonResult {
  let index = 0

  const skipWhitespace = (): void => {
    while (index < text.length && /\s/.test(text[index] ?? '')) {
      index += 1
    }
  }

  const parseString = (): string | null => {
    if (text[index] !== '"') {
      return null
    }
    const start = index
    index += 1
    let escaped = false
    while (index < text.length) {
      const char = text[index]
      if (!escaped && char === '"') {
        index += 1
        try {
          const value = JSON.parse(text.slice(start, index)) as unknown
          return typeof value === 'string' && value === value.normalize('NFC') ? value : null
        } catch {
          return null
        }
      }
      if (!escaped && char === '\\') {
        escaped = true
      } else {
        if (!escaped && char !== undefined && char.charCodeAt(0) < 0x20) {
          return null
        }
        escaped = false
      }
      index += 1
    }
    return null
  }

  const parseValue = (depth: number): boolean => {
    if (depth > MAX_JSON_DEPTH) {
      return false
    }
    skipWhitespace()
    const char = text[index]
    if (char === '"') {
      return parseString() !== null
    }
    if (char === '{') {
      index += 1
      skipWhitespace()
      const keys = new Set<string>()
      if (text[index] === '}') {
        index += 1
        return true
      }
      while (index < text.length) {
        skipWhitespace()
        const key = parseString()
        if (key === null || keys.has(key)) {
          return false
        }
        keys.add(key)
        skipWhitespace()
        if (text[index] !== ':') {
          return false
        }
        index += 1
        if (!parseValue(depth + 1)) {
          return false
        }
        skipWhitespace()
        if (text[index] === '}') {
          index += 1
          return true
        }
        if (text[index] !== ',') {
          return false
        }
        index += 1
      }
      return false
    }
    if (char === '[') {
      index += 1
      skipWhitespace()
      if (text[index] === ']') {
        index += 1
        return true
      }
      while (index < text.length) {
        if (!parseValue(depth + 1)) {
          return false
        }
        skipWhitespace()
        if (text[index] === ']') {
          index += 1
          return true
        }
        if (text[index] !== ',') {
          return false
        }
        index += 1
      }
      return false
    }
    const rest = text.slice(index)
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      rest,
    )?.[0]
    if (!primitive) {
      return false
    }
    index += primitive.length
    const value = JSON.parse(primitive) as unknown
    return typeof value !== 'number' || Number.isFinite(value)
  }

  if (!parseValue(0)) {
    return { ok: false }
  }
  skipWhitespace()
  if (index !== text.length) {
    return { ok: false }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}
