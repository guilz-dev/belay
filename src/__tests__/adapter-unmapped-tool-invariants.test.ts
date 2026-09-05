import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { handleToolGateHook } from '../adapters/cursor/runtime-entry.js'
import { loadConfigFile, writeTrustedConfigFile } from '../config-io.js'
import { mergeConfig } from '../core/config.js'
import { getManagedHookEntries } from '../defaults.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-unmapped-tool-'))
  tempDirs.push(repoRoot)
  return repoRoot
}

describe('adapter unmapped tool invariants', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('installs exactly one unfiltered preToolUse managed hook', () => {
    const repoRoot = '/tmp/project'
    const hooksDir = path.join(repoRoot, '.cursor', 'hooks')
    const preToolUse = getManagedHookEntries(process.platform, hooksDir, repoRoot).filter(
      (entry) => entry.event === 'preToolUse',
    )

    expect(preToolUse).toHaveLength(1)
    expect(preToolUse[0].definition.matcher).toBeUndefined()
  })

  it('keeps preToolUse Shell as neutral allow', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    await expect(
      handleToolGateHook('preToolUse', {
        tool_name: 'Shell',
        cwd: repoRoot,
      }),
    ).resolves.toEqual({ permission: 'allow' })
  })

  it('keeps preToolUse Shell neutral when repository config trust is stale', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { mode: string }
    await writeFile(configPath, `${JSON.stringify({ ...config, mode: 'audit' })}\n`)

    await expect(
      handleToolGateHook('preToolUse', {
        tool_name: 'Shell',
        cwd: repoRoot,
      }),
    ).resolves.toEqual({ permission: 'allow' })
  })

  it('keeps malformed preToolUse Shell payloads neutral before dispatcher routing', async () => {
    const { PassThrough } = await import('node:stream')
    const { dispatchCursorHookResponse } = await import('../adapters/cursor/hook-dispatch-entry.js')
    const stdin = new PassThrough()
    const originalStdin = process.stdin
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin })

    try {
      const responsePromise = dispatchCursorHookResponse({
        origin: { scope: 'project', repoRoot: '/tmp/project' },
        kind: 'tool-gate',
        eventName: 'preToolUse',
      })
      stdin.end(JSON.stringify({ tool_name: 'Shell', tool_input: null }))
      await expect(responsePromise).resolves.toEqual({ permission: 'allow' })
    } finally {
      Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin })
    }
  })

  it('evaluates and audits unmapped preToolUse tools in enforce mode', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    await writeTrustedConfigFile(
      repoRoot,
      mergeConfig({ ...(await loadConfigFile(repoRoot)), mode: 'enforce' }),
    )

    await expect(
      handleToolGateHook('preToolUse', {
        tool_name: 'FutureMutationTool',
        tool_input: {},
        cwd: repoRoot,
      }),
    ).resolves.toMatchObject({ permission: 'deny' })

    const audit = await readFile(path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson'), 'utf8')
    expect(audit).toContain('"kind":"tool"')
    expect(audit).toContain('"wouldBlock":true')
  })

  it('allows but audits unmapped preToolUse tools in audit mode', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })
    await writeTrustedConfigFile(
      repoRoot,
      mergeConfig({ ...(await loadConfigFile(repoRoot)), mode: 'audit' }),
    )

    await expect(
      handleToolGateHook('preToolUse', {
        tool_name: 'FutureMutationTool',
        tool_input: {},
        cwd: repoRoot,
      }),
    ).resolves.toMatchObject({ permission: 'allow' })

    const audit = await readFile(path.join(repoRoot, '.cursor', 'belay', 'audit.ndjson'), 'utf8')
    expect(audit).toContain('"kind":"tool"')
    expect(audit).toContain('"wouldBlock":true')
    expect(audit).toContain('"mode":"audit"')
  })

  it('dispatcher denies preToolUse with tool_name but malformed tool_input', async () => {
    const { PassThrough } = await import('node:stream')
    const { dispatchCursorHookResponse } = await import('../adapters/cursor/hook-dispatch-entry.js')

    const stdin = new PassThrough()
    const originalStdin = process.stdin
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: stdin,
    })

    try {
      const responsePromise = dispatchCursorHookResponse({
        origin: { scope: 'project', repoRoot: '/tmp/project' },
        kind: 'tool-gate',
        eventName: 'preToolUse',
      })
      stdin.end(
        JSON.stringify({
          tool_name: 'FutureMutationTool',
          tool_input: null,
          cwd: '/tmp/project',
        }),
      )
      await expect(responsePromise).resolves.toEqual({
        permission: 'deny',
        user_message:
          'belay received a malformed preToolUse payload. Run belay doctor, then retry.',
      })
    } finally {
      Object.defineProperty(process, 'stdin', {
        configurable: true,
        value: originalStdin,
      })
    }
  })
})
