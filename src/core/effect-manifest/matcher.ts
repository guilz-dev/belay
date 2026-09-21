import type { ArgvMatcherV1 } from './types.js'

export type ManifestCaptures = Record<string, string>

function matchesHost(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    !value.includes('/') &&
    /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)$/.test(value)
  )
}

function parseInteger(value: string): number | null {
  if (!/^(?:0|-?[1-9]\d*)$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function tokenMatches(value: string, token: ArgvMatcherV1): boolean {
  switch (token.kind) {
    case 'literal':
      return value === token.value
    case 'enum':
      return token.values.includes(value)
    case 'path':
    case 'token':
      return value.length > 0 && !value.includes('\0')
    case 'host':
      return matchesHost(value)
    case 'integer': {
      const parsed = parseInteger(value)
      return (
        parsed !== null &&
        (token.min === undefined || parsed >= token.min) &&
        (token.max === undefined || parsed <= token.max)
      )
    }
  }
}

export function matchArgv(
  argv: readonly string[],
  matcher: readonly ArgvMatcherV1[],
): ManifestCaptures | null {
  if (argv.length !== matcher.length) {
    return null
  }
  const captures: ManifestCaptures = {}
  for (let index = 0; index < matcher.length; index += 1) {
    const token = matcher[index]
    const value = argv[index]
    if (!token || value === undefined || !tokenMatches(value, token)) {
      return null
    }
    if (token.kind !== 'literal') {
      captures[token.name] = value
    }
  }
  return captures
}

export function argvMatchesMatcher(
  argv: readonly string[],
  matcher: readonly ArgvMatcherV1[],
): boolean {
  return matchArgv(argv, matcher) !== null
}

function integerBounds(token: Extract<ArgvMatcherV1, { kind: 'integer' }>): [number, number] {
  return [token.min ?? Number.MIN_SAFE_INTEGER, token.max ?? Number.MAX_SAFE_INTEGER]
}

function matcherElementsOverlap(left: ArgvMatcherV1, right: ArgvMatcherV1): boolean {
  if (left.kind === 'literal') {
    return tokenMatches(left.value, right)
  }
  if (right.kind === 'literal') {
    return tokenMatches(right.value, left)
  }
  if (left.kind === 'enum') {
    return left.values.some((value) => tokenMatches(value, right))
  }
  if (right.kind === 'enum') {
    return right.values.some((value) => tokenMatches(value, left))
  }
  if (left.kind === 'integer' && right.kind === 'integer') {
    const [leftMin, leftMax] = integerBounds(left)
    const [rightMin, rightMax] = integerBounds(right)
    return Math.max(leftMin, rightMin) <= Math.min(leftMax, rightMax)
  }
  // token/path domains include every bounded scalar accepted by host/integer captures.
  if (
    left.kind === 'token' ||
    left.kind === 'path' ||
    right.kind === 'token' ||
    right.kind === 'path'
  ) {
    return true
  }
  // Host and integer overlap on non-negative decimal host labels such as "1".
  const integer = left.kind === 'integer' ? left : right.kind === 'integer' ? right : null
  return integer ? (integer.max ?? Number.MAX_SAFE_INTEGER) >= 0 : true
}

export function matcherLanguagesOverlap(
  left: readonly ArgvMatcherV1[],
  right: readonly ArgvMatcherV1[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index]
      return other !== undefined && matcherElementsOverlap(entry, other)
    })
  )
}

export interface MatchedManifestRule<TRule> {
  rule: TRule
  captures: ManifestCaptures
}

export function findUniqueMatchingRule<
  TRule extends { id: string; matcher: { argv: ArgvMatcherV1[] } },
>(argv: readonly string[], rules: readonly TRule[]): MatchedManifestRule<TRule> | null {
  const matches = rules.flatMap((rule) => {
    const captures = matchArgv(argv, rule.matcher.argv)
    return captures ? [{ rule, captures }] : []
  })
  const [match] = matches
  return matches.length === 1 && match ? match : null
}
