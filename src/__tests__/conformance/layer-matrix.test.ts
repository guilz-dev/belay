import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { cursorAdapter } from '../../adapters/cursor/adapter.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../../adapters/shared/gate-runtime.js'
import {
  LAYER_CONFORMANCE_SCENARIOS,
  type LayerProfileId,
  layerProfileConfig,
} from '../../conformance/layer-profiles.js'
import type { BelayConfigV3 } from '../../core/config.js'

async function withProfileRepo(
  profile: LayerProfileId,
  run: (repoRoot: string, config: BelayConfigV3) => Promise<void>,
) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), `belay-layer-${profile}-`))
  await mkdir(path.join(repoRoot, '.git'))
  await cursorAdapter.install(repoRoot, {})
  const config = layerProfileConfig(profile)
  await run(repoRoot, config)
}

describe('layer conformance matrix', () => {
  for (const profile of Object.keys(LAYER_CONFORMANCE_SCENARIOS) as LayerProfileId[]) {
    describe(profile, () => {
      for (const scenario of LAYER_CONFORMANCE_SCENARIOS[profile]) {
        it(`${scenario.command} -> ${scenario.permission}`, async () => {
          await withProfileRepo(profile, async (repoRoot, config) => {
            const ctx = {
              layout: cursorAdapter.layout,
              repoRoot,
              config,
              configPath: cursorAdapter.layout.configPath(repoRoot),
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
    })
  }
})
