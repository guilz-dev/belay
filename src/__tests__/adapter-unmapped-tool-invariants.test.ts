import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { handleToolGateHook } from '../adapters/cursor/runtime-entry.js'
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

  it('fails closed for unmapped preToolUse tools', async () => {
    const repoRoot = await createTempRepo()
    await initProject({ targetDir: repoRoot })

    await expect(
      handleToolGateHook('preToolUse', {
        tool_name: 'Read',
        cwd: repoRoot,
      }),
    ).resolves.toEqual({
      permission: 'deny',
      user_message:
        'belay denied unmapped Cursor tool "Read". Run belay doctor, then upgrade belay if needed.',
    })
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
