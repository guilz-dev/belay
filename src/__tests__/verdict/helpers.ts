import path from 'node:path'
import { createDeterministicJudgeStub } from '../../core/verdict/judge.js'
import type { VerdictContext } from '../../core/verdict/types.js'

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
