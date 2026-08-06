import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeAdapter } from '../../adapters/claude/adapter.js'
import { cursorAdapter } from '../../adapters/cursor/adapter.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../../adapters/shared/gate-runtime.js'
import { BOUNDARY_PROFILE_L3_L4_ONLY } from '../../core/capability/boundary-profile.js'
import { CAPABILITY_REQUEST_VERSION } from '../../core/capability/request.js'
import { mergeConfig } from '../../core/config.js'

const adapters = [cursorAdapter, claudeAdapter] as const

describe('adapter capability conformance', () => {
  for (const adapter of adapters) {
    describe(adapter.name, () => {
      it('emits capability metadata for denied network shell actions', async () => {
        const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-capability-'))
        await mkdir(path.join(repoRoot, '.git'))
        await adapter.install(repoRoot, {})
        const config = mergeConfig(adapter.layout.defaultConfig(repoRoot))
        const ctx = {
          layout: adapter.layout,
          repoRoot,
          config: { ...config, mode: 'enforce' as const },
          configPath: adapter.layout.configPath(repoRoot),
        }
        const deps = createDefaultGateRuntimeDeps()
        const verdict = await evaluateGatedAction(ctx, deps, {
          kind: 'shell',
          cwd: repoRoot,
          command: 'curl https://example.com',
        })
        expect(verdict.permission).toBe('deny')
        expect(verdict.capabilityRequests?.[0]?.version).toBe(CAPABILITY_REQUEST_VERSION)
        expect(verdict.boundaryProfile).toBe(BOUNDARY_PROFILE_L3_L4_ONLY)
      })
    })
  }
})
