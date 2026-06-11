import { relativeWithinRepo, resolveMutationTarget } from '../path-utils.js'
import { extractRedirectTargets, tokenizeShell } from '../shell-tokenizer.js'

export function collectOutsideRepoPaths(command: string, cwd: string, repoRoot: string): string[] {
  const tokens = tokenizeShell(command)
  const redirects = extractRedirectTargets(tokens)
  const paths = new Set<string>()

  for (const token of tokens.slice(1)) {
    const resolved = resolveMutationTarget(token, cwd)
    if (resolved && relativeWithinRepo(repoRoot, resolved) === null) {
      paths.add(resolved)
    }
  }

  for (const redirect of redirects) {
    const resolved = resolveMutationTarget(redirect, cwd)
    if (resolved && relativeWithinRepo(repoRoot, resolved) === null) {
      paths.add(resolved)
    }
  }

  return [...paths]
}
