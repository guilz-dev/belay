import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cursorLayout } from '../../adapters/layouts/cursor.js'
import {
  createDefaultGateRuntimeDeps,
  evaluateGatedAction,
} from '../../adapters/shared/gate-runtime.js'
import { DEFAULT_CONFIG_V3 } from '../../core/config.js'

describe('gate-runtime v2 integration', () => {
  it('allows git status through v2 engine', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-v2-gate-'))
    const configPath = path.join(repoRoot, '.belay', 'config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG_V3, null, 2)}\n`, 'utf8')

    const auditEvents: Record<string, unknown>[] = []
    const deps = createDefaultGateRuntimeDeps()
    const ctx = {
      layout: cursorLayout,
      repoRoot,
      config: DEFAULT_CONFIG_V3,
      configPath,
    }
    const patchedDeps = {
      ...deps,
      async appendAudit(_ctx: typeof ctx, event: Record<string, unknown>) {
        auditEvents.push(event)
      },
    }

    const verdict = await evaluateGatedAction(ctx, patchedDeps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'git status',
    })

    expect(verdict.permission).toBe('allow')
    expect(verdict.v2?.location).toBe('repo_local')
    expect(auditEvents[0]?.schemaVersion).toBe(2)
    expect(auditEvents[0]?.location).toBe('repo_local')
  })

  it('blocks rm -rf .git and creates v2 audit trace', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-v2-gate-'))
    const configPath = path.join(repoRoot, '.belay', 'config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG_V3, null, 2)}\n`, 'utf8')

    const auditEvents: Record<string, unknown>[] = []
    const deps = createDefaultGateRuntimeDeps()
    const ctx = {
      layout: cursorLayout,
      repoRoot,
      config: DEFAULT_CONFIG_V3,
      configPath,
    }
    const patchedDeps = {
      ...deps,
      async appendAudit(_ctx: typeof ctx, event: Record<string, unknown>) {
        auditEvents.push(event)
      },
    }

    const verdict = await evaluateGatedAction(ctx, patchedDeps, {
      kind: 'shell',
      cwd: repoRoot,
      command: 'rm -rf .git',
    })

    expect(verdict.permission).toBe('deny')
    expect(verdict.v2?.would).toBe('ask')
    expect(auditEvents[0]?.effect).toBeDefined()
  })
})
