import path from 'node:path'

/** Resolve structural suite fixture root for a repository checkout. */
export function structuralFixtureRoot(repoRoot: string): string {
  return path.join(repoRoot, 'src', '__tests__', 'verdict', 'fixtures')
}
