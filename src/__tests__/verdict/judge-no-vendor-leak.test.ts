import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_V4, migrateConfig } from '../../core/config.js'
import { JudgeEndpointRequiredError, resolveInitJudgeConfig } from '../../core/judge-config.js'
import * as judgeModule from '../../core/verdict/judge.js'

describe('T16 no default base / no vendor leak', () => {
  it('does not export DEFAULT_CURSOR_API_BASE from judge module', () => {
    expect('DEFAULT_CURSOR_API_BASE' in judgeModule).toBe(false)
  })

  it('does not reference api.cursor.com in source tree', async () => {
    const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const files = [
      'core/verdict/judge.ts',
      'core/judge-config.ts',
      'core/judge-doctor.ts',
      'cli.ts',
    ]
    for (const relative of files) {
      const content = await readFile(path.join(srcRoot, relative), 'utf8')
      expect(content).not.toContain('api.cursor.com')
    }
  })

  it('requires endpoint for openai-compatible init', () => {
    expect(() =>
      resolveInitJudgeConfig({
        isFresh: true,
        hasExplicitJudgeFlags: true,
        judgeProvider: 'openai-compatible',
        acceptCloudJudge: true,
      }),
    ).toThrow(JudgeEndpointRequiredError)
  })

  it('normalizes migrated cursor provider without endpoint', () => {
    const config = migrateConfig({
      ...DEFAULT_CONFIG_V4,
      judge: {
        provider: 'cursor',
        model: 'auto',
        endpoint: null,
        timeoutMs: 8000,
        keepAlive: null,
      },
    })
    expect(config.judge.provider).toBe('openai-compatible')
    expect(config.judge.endpoint).toBeNull()
  })
})
