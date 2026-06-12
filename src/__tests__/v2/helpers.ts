import path from 'node:path'
import { createDeterministicJudgeStub } from '../../core/v2/judge.js'
import type { VerdictContext } from '../../core/v2/types.js'

const FIXTURE_ROOT = path.join(import.meta.dirname, 'fixtures')

export function v2TestContext(overrides: Partial<VerdictContext> = {}): VerdictContext {
  return {
    cwd: FIXTURE_ROOT,
    repoRoot: FIXTURE_ROOT,
    trustedCwd: true,
    sensitivePaths: ['.env', '.env.*', '**/credentials/**'],
    judge: createDeterministicJudgeStub(),
    mode: 'enforce',
    unknownLocalEffect: 'deny',
    unparseableShell: 'deny',
    ...overrides,
  }
}
