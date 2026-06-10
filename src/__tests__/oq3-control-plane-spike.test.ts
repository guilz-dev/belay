import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { runControlPlaneSpike } from '../core/control-plane-spike.js'

describe('OQ3 control plane spike', () => {
  it('reads and writes under XDG_CONFIG_HOME/agent-belay from hook-like context', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'belay-oq3-home-'))
    const tempCwd = await mkdtemp(path.join(os.tmpdir(), 'belay-oq3-cwd-'))
    const xdgConfigHome = path.join(tempHome, 'xdg-config')

    try {
      const result = await runControlPlaneSpike(
        { HOME: tempHome, XDG_CONFIG_HOME: xdgConfigHome },
        tempCwd,
        () => tempHome,
      )

      expect(result.ok).toBe(true)
      expect(result.controlPlaneDir).toBe(path.join(xdgConfigHome, 'agent-belay'))
      expect(result.wrote).toBe(true)
      expect(result.readBack).toContain(tempCwd)
      expect(existsSync(result.controlPlaneDir)).toBe(true)
      expect(existsSync(result.testFile)).toBe(false)
    } finally {
      await rm(tempHome, { recursive: true, force: true })
      await rm(tempCwd, { recursive: true, force: true })
    }
  })

  it('falls back to ~/.config/agent-belay when XDG_CONFIG_HOME is unset', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'belay-oq3-home2-'))
    const tempCwd = await mkdtemp(path.join(os.tmpdir(), 'belay-oq3-cwd2-'))

    try {
      const result = await runControlPlaneSpike({ HOME: tempHome }, tempCwd, () => tempHome)

      expect(result.ok).toBe(true)
      expect(result.controlPlaneDir).toBe(path.join(tempHome, '.config', 'agent-belay'))
    } finally {
      await rm(tempHome, { recursive: true, force: true })
      await rm(tempCwd, { recursive: true, force: true })
    }
  })
})
