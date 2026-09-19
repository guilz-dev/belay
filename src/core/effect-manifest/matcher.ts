import type { ArgvMatcherV1 } from './types.js'

export function argvMatchesMatcher(
  argv: readonly string[],
  matcher: readonly ArgvMatcherV1[],
): boolean {
  if (argv.length !== matcher.length) {
    return false
  }
  for (let index = 0; index < matcher.length; index += 1) {
    const token = matcher[index]
    const value = argv[index]
    if (token.kind === 'literal') {
      if (value !== token.value) {
        return false
      }
      continue
    }
    // Typed captures are validated at trust time; runtime only checks shape for literals in v1 tests.
    return false
  }
  return true
}

export function findUniqueMatchingRule<
  TRule extends { id: string; matcher: { argv: ArgvMatcherV1[] } },
>(argv: readonly string[], rules: readonly TRule[]): TRule | null {
  const matches = rules.filter((rule) => argvMatchesMatcher(argv, rule.matcher.argv))
  const [match] = matches
  return matches.length === 1 ? match : null
}
