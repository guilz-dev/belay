import path from 'node:path'

import { mergeConfig } from '../../core/config.js'
import type { VerdictContext } from '../../core/verdict/types.js'

const FIXTURE_ROOT = path.join(import.meta.dirname, 'fixtures')

export function verdictTestContext(overrides: Partial<VerdictContext> = {}): VerdictContext {
  const config = mergeConfig({})
  return {
    cwd: FIXTURE_ROOT,
    repoRoot: FIXTURE_ROOT,
    config,
    trustedCwd: true,
    sensitivePaths: ['.env', '.env.*', '**/credentials/**'],
    mode: 'enforce',
    unknownLocalEffect: 'deny',
    unparseableShell: 'deny',
    ...overrides,
  }
}
