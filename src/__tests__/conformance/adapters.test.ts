import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { claudeAdapter } from '../../adapters/claude/adapter.js'
import { cursorAdapter } from '../../adapters/cursor/adapter.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../../adapters/shared/gate-runtime.js'
import { type BelayConfigV3, mergeConfig } from '../../core/config.js'

const scenarios = [
  { command: 'git status', permission: 'allow' as const },
  { command: 'curl https://example.com', permission: 'deny' as const },
  { command: '', permission: 'deny' as const, reason: 'normalization_failed' },
]

async function withAdapterRepo(
  adapter: typeof cursorAdapter | typeof claudeAdapter,
  run: (repoRoot: string) => Promise<void>,
) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-conformance-'))
  await mkdir(path.join(repoRoot, '.git'))
  await adapter.install(repoRoot, {})
  await run(repoRoot)
}

describe('adapter conformance suite', () => {
  for (const adapter of [cursorAdapter, claudeAdapter]) {
    describe(adapter.name, () => {
      for (const scenario of scenarios) {
        it(`${scenario.command || '(empty)'} -> ${scenario.permission}`, async () => {
          await withAdapterRepo(adapter, async (repoRoot) => {
            const config = mergeConfig(
              JSON.parse(await readFile(adapter.layout.configPath(repoRoot), 'utf8')),
              adapter.layout.defaultConfig(repoRoot) as BelayConfigV3,
            )
            const ctx = {
              layout: adapter.layout,
              repoRoot,
              config,
              configPath: adapter.layout.configPath(repoRoot),
            }
            const deps = createDefaultGateRuntimeDeps()
            const verdict = await evaluateGatedAction(ctx, deps, {
              kind: 'shell',
              cwd: repoRoot,
              command: scenario.command,
            })
            expect(verdict.permission).toBe(scenario.permission)
            if (scenario.reason) {
              expect(verdict.reason).toBe(scenario.reason)
            }
          })
        })
      }

      it('writes adapter-specific config and runtime paths', async () => {
        await withAdapterRepo(adapter, async (repoRoot) => {
          expect(adapter.layout.configPath(repoRoot)).toContain(
            adapter.name === 'cursor' ? '.cursor' : '.claude',
          )
          const runtimePath = path.join(adapter.layout.runtimeDir(repoRoot), 'core.mjs')
          const runtime = await readFile(runtimePath, 'utf8')
          expect(runtime).toContain('RUNTIME_PACKAGE_VERSION')
        })
      })
    })
  }
})
