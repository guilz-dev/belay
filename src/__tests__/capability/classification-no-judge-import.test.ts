import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

const CLASSIFICATION_FILES = [
  'src/core/verdict/verdict.ts',
  'src/core/verdict/adapter.ts',
  'src/core/verdict/shell-policy.ts',
  'src/core/verdict/prescan.ts',
  'src/core/capability/resolver.ts',
  'src/core/classify-tool.ts',
  'src/core/classify-subagent.ts',
  'src/core/gate-engine.ts',
]

const FORBIDDEN_PATTERNS = [
  /from\s+['"].*judge-factory(?:\.js)?['"]/,
  /from\s+['"].*\/judge(?:\.js)?['"]/,
  /createJudgeFromConfig/,
]

describe('classification layer static judge isolation', () => {
  for (const relativePath of CLASSIFICATION_FILES) {
    it(`${relativePath} does not import sync judge modules`, async () => {
      const source = await readFile(path.join(REPO_ROOT, relativePath), 'utf8')
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(source, `forbidden pattern ${pattern}`).not.toMatch(pattern)
      }
    })
  }
})
