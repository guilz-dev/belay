import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { cursorAdapter } from '../adapters/cursor/adapter.js'
import { runtimeClassifierOptions } from '../adapters/shared/gate-runtime.js'
import { belayStateDir } from '../config-io.js'
import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { writeEgressDaemonState } from '../services/egress-service.js'
import { classifyShellGated } from './helpers/shell-classify.js'

const tempDirs: string[] = []

describe('egress runtime classifier options', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('runtimeClassifierOptions never loosens shell gating when the proxy is running', async () => {
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
    expect(inactive.demoteL3External).toBeUndefined()

    const stateDir = belayStateDir(config, cursorAdapter.layout.repoLocalStateDir(repoRoot))
    await writeEgressDaemonState({
      stateDir,
      pid: process.pid,
      host: '127.0.0.1',
      port: 17831,
      repoRoot,
    })

    const active = runtimeClassifierOptions(ctx, config)
    expect(active.demoteL3External).toBeUndefined()

    const cwd = path.join(repoRoot, 'src')
    await mkdir(cwd, { recursive: true })
    const denied = await classifyShellGated('git push origin main', cwd, repoRoot, config, inactive)
    expect(denied.verdict).toBe('deny_pending_approval')

    const stillDenied = await classifyShellGated(
      'git push origin main',
      cwd,
      repoRoot,
      config,
      active,
    )
    expect(stillDenied.verdict).toBe('deny_pending_approval')
    expect(stillDenied.reason).toBe('external_effect')
  })
})
