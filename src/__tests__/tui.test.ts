import { afterEach, describe, expect, it, vi } from 'vitest'

import { confirmPrompt, selectPrompt } from '../commands/tui.js'
import { emitKeypress, mockInteractiveTTY, mockSetRawMode } from './helpers/tty.js'

const originalNoColor = process.env.NO_COLOR
const originalTerm = process.env.TERM

describe('tui prompts', () => {
  let restoreTTY: (() => void) | undefined
  let restoreRawMode: (() => void) | undefined

  afterEach(() => {
    vi.restoreAllMocks()
    restoreRawMode?.()
    restoreRawMode = undefined
    restoreTTY?.()
    restoreTTY = undefined
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = originalNoColor
    }
    if (originalTerm === undefined) {
      delete process.env.TERM
    } else {
      process.env.TERM = originalTerm
    }
  })

  it('throws on non-interactive tty', () => {
    restoreTTY = mockInteractiveTTY(false)
    expect(() =>
      selectPrompt({
        message: 'Adapter',
        defaultValue: 'cursor',
        choices: [{ value: 'cursor' }, { value: 'codex' }],
      }),
    ).toThrow(/interactive TTY/i)
  })

  it('throws when choices are empty', () => {
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    expect(() =>
      selectPrompt<'cursor'>({
        message: 'Adapter',
        defaultValue: 'cursor',
        choices: [],
      }),
    ).toThrow(/at least one choice/i)
  })

  it('selects the default value on Enter', async () => {
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const promise = selectPrompt({
      message: 'Adapter',
      defaultValue: 'cursor',
      choices: [{ value: 'cursor' }, { value: 'codex' }],
    })
    await emitKeypress('enter')
    await expect(promise).resolves.toBe('cursor')
    expect(raw.calls).toEqual([true, false])
  })

  it('supports arrow down and Enter', async () => {
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const promise = selectPrompt({
      message: 'Provider',
      defaultValue: 'cursor',
      choices: [{ value: 'cursor' }, { value: 'codex' }, { value: 'claude' }],
    })
    await emitKeypress('down')
    await emitKeypress('enter')
    await expect(promise).resolves.toBe('codex')
    expect(raw.calls).toEqual([true, false])
  })

  it('supports j and k navigation', async () => {
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const first = selectPrompt({
      message: 'Provider',
      defaultValue: 'cursor',
      choices: [{ value: 'cursor' }, { value: 'codex' }, { value: 'claude' }],
    })
    await emitKeypress('j')
    await emitKeypress('enter')
    await expect(first).resolves.toBe('codex')

    const second = selectPrompt({
      message: 'Provider',
      defaultValue: 'cursor',
      choices: [{ value: 'cursor' }, { value: 'codex' }, { value: 'claude' }],
    })
    await emitKeypress('k')
    await emitKeypress('enter')
    await expect(second).resolves.toBe('claude')
    expect(raw.calls).toEqual([true, false, true, false])
  })

  it('rejects on Ctrl-C', async () => {
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const promise = selectPrompt({
      message: 'Provider',
      defaultValue: 'cursor',
      choices: [{ value: 'cursor' }, { value: 'codex' }],
    })
    await emitKeypress('c', true)
    await expect(promise).rejects.toThrow('Cancelled.')
    expect(raw.calls).toEqual([true, false])
  })

  it('renders without color codes when NO_COLOR is set', async () => {
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    process.env.NO_COLOR = '1'
    process.env.TERM = 'xterm-256color'
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })

    const promise = selectPrompt({
      message: 'Provider',
      defaultValue: 'cursor',
      choices: [{ value: 'cursor' }, { value: 'codex' }],
    })
    await emitKeypress('enter')
    await expect(promise).resolves.toBe('cursor')
    const rendered = writes.join('')
    expect(rendered).not.toContain('\u001b[1m')
    expect(rendered).not.toContain('\u001b[2m')
    expect(rendered).not.toContain('\u001b[4m')
    expect(rendered).not.toContain('\u001b[32m')
    expect(rendered).not.toContain('\u001b[36m')
    expect(raw.calls).toEqual([true, false])
  })

  it('confirmPrompt resolves false when selecting No', async () => {
    restoreTTY = mockInteractiveTTY(true)
    const raw = mockSetRawMode()
    restoreRawMode = raw.restore
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const promise = confirmPrompt('Accept?', true)
    await emitKeypress('j')
    await emitKeypress('enter')
    await expect(promise).resolves.toBe(false)
    expect(raw.calls).toEqual([true, false])
  })
})
