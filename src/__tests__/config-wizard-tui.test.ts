import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  runBelayConfigInteractive,
  runBelayConfigJudgeOnlyInteractive,
} from '../commands/config.js'
import { loadConfigFile } from '../config-io.js'
import { initProject } from '../installer.js'
import { emitKeypress, mockInteractiveTTY, mockSetRawMode } from './helpers/tty.js'

const tempDirs: string[] = []

async function createTempRepo(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-config-tui-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('config wizard TUI integration', () => {
  let restoreTTY: (() => void) | undefined
  let restoreRawMode: (() => void) | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    restoreRawMode?.()
    restoreRawMode = undefined
    restoreTTY?.()
    restoreTTY = undefined
    vi.doUnmock('node:readline/promises')
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('updates provider from judge-only wizard via keypress selection', async () => {
    const dir = await createTempRepo()
    await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })

    const promise = runBelayConfigJudgeOnlyInteractive({ targetDir: dir })
    await vi.waitFor(() => expect(writes.join('')).toContain('Judge provider'))
    await emitKeypress('down')
    await emitKeypress('enter')
    await expect(promise).resolves.toMatchObject({ repoRoot: dir, adapter: 'cursor' })
    expect(raw.calls).toEqual([true, false])

    const config = await loadConfigFile(dir)
    expect(config.judge.providerId).toBe('ollama')
  })

  it('aborts interactive wizard when user presses Ctrl-C', async () => {
    const dir = await createTempRepo()
    await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })

    const promise = runBelayConfigInteractive({ targetDir: dir })
    await vi.waitFor(() => expect(writes.join('')).toContain('Configure judge only?'))
    await emitKeypress('c', true)
    await expect(promise).rejects.toThrow('Cancelled.')
    expect(raw.calls).toEqual([true, false])
  })

  it('mixes TUI selection with readline text input in judge-only flow', async () => {
    const dir = await createTempRepo()
    await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
    const question = vi.fn(async () => 'https://api.openai.com/v1')
    const close = vi.fn()
    vi.spyOn(readline, 'createInterface').mockReturnValue({
      question,
      close,
    } as unknown as ReturnType<typeof readline.createInterface>)

    const promise = runBelayConfigJudgeOnlyInteractive({ targetDir: dir })
    await vi.waitFor(() => expect(writes.join('')).toContain('Judge provider'))
    await emitKeypress('k') // cursor -> claude
    await emitKeypress('enter')
    await vi.waitFor(() => expect(writes.join('')).toContain('Use project env for credentials?'))
    await emitKeypress('enter')
    await vi.waitFor(() => expect(question).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(writes.join('')).toContain('Accept cloud judge egress'))
    await emitKeypress('k') // no -> yes
    await emitKeypress('enter')
    await expect(promise).resolves.toMatchObject({ repoRoot: dir, adapter: 'cursor' })
    expect(raw.calls).toEqual([true, false, true, false, true, false])
    expect(close).toHaveBeenCalledTimes(1)

    const config = await loadConfigFile(dir)
    expect(config.judge.providerId).toBe('claude')
    expect(config.judge.endpoint).toBe('https://api.openai.com/v1')
    expect(config.judge.cloudConsent?.accepted).toBe(true)
  })

  it('falls back to readline prompts and accepts legacy provider aliases', async () => {
    const dir = await createTempRepo()
    await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })
    restoreTTY = mockInteractiveTTY(false)

    const answers = ['openai', 'y', '']
    const question = vi.fn(async () => answers.shift() ?? '')
    const close = vi.fn()
    vi.resetModules()
    vi.doMock('node:readline/promises', () => ({
      default: {
        createInterface: () => ({
          question,
          close,
        }),
      },
    }))

    const configModule = await import('../commands/config.js')
    await configModule.runBelayConfigJudgeOnlyInteractive({ targetDir: dir })

    expect(question).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(3)
    const config = await loadConfigFile(dir)
    expect(config.judge.providerId).toBe('codex')
  })
})
