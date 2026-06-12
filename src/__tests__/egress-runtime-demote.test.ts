import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { cursorAdapter } from '../adapters/cursor/adapter.js'
import { runtimeClassifierOptions } from '../adapters/shared/gate-runtime.js'
import { belayStateDir } from '../config-io.js'
import { classifyShell } from '../core/classify-shell.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { writeEgressDaemonState } from '../services/egress-service.js'

const tempDirs: string[] = []

describe('egress L3 demotion runtime gating', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('runtimeClassifierOptions demotes only when proxy status shows a live daemon', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-runtime-demote-'))
    tempDirs.push(repoRoot)
    await mkdir(path.join(repoRoot, '.git'))
    const config = {
      ...DEFAULT_CONFIG_V3,
      egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true, demoteL3External: true },
    }
    const ctx = {
      layout: cursorAdapter.layout,
      repoRoot,
      config,
      configPath: cursorAdapter.layout.configPath(repoRoot),
    }

    const inactive = runtimeClassifierOptions(ctx, config)
    expect(inactive.demoteL3External).toBe(false)

    const stateDir = belayStateDir(config, cursorAdapter.layout.repoLocalStateDir(repoRoot))
    await writeEgressDaemonState({
      stateDir,
      pid: process.pid,
      host: '127.0.0.1',
      port: 17831,
      repoRoot,
    })

    const active = runtimeClassifierOptions(ctx, config)
    expect(active.demoteL3External).toBe(true)

    const cwd = path.join(repoRoot, 'src')
    await mkdir(cwd, { recursive: true })
    const denied = classifyShell('git push origin main', cwd, repoRoot, inactive)
    expect(denied.verdict).toBe('deny_pending_approval')

    const flagged = classifyShell('git push origin main', cwd, repoRoot, active)
    expect(flagged.verdict).toBe('allow_flagged')
    expect(flagged.reason).toBe('l3_external_hint')
  })
})
