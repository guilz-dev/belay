/**
 * Zero-dependency terminal UI helpers for the interactive `belay config` wizard.
 *
 * Everything here is built on Node's built-in `readline`/`tty` only — no runtime
 * dependencies — so it stays aligned with belay's zero-dependency posture.
 *
 * This module is intentionally TTY-only. Callers are responsible for non-TTY
 * fallback behavior.
 */

import { stdin as input, stdout as output } from 'node:process'
import readline from 'node:readline'

const isColorEnabled = () =>
  isInteractiveTTY() && !process.env.NO_COLOR && process.env.TERM !== 'dumb'

const symbol = (pretty: string, plain: string) => (isColorEnabled() ? pretty : plain)

const wrap = (open: number, close: number) => (s: string) =>
  isColorEnabled() ? `\x1b[${open}m${s}\x1b[${close}m` : s

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  cyan: wrap(36, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  red: wrap(31, 39),
  gray: wrap(90, 39),
}

/** A select wizard only makes sense when both stdin and stdout are real TTYs. */
export function isInteractiveTTY(): boolean {
  return Boolean(input.isTTY && output.isTTY)
}

const symPointer = () => symbol('❯', '>')
const symCheck = () => symbol('✓', 'v')
const symBar = () => symbol('│', '|')
const symQuestion = () => '?'

/** Top banner shown once at the start of the wizard. */
export function intro(title: string, subtitle?: string): void {
  output.write('\n')
  output.write(`${c.green(symBar())} ${c.bold(title)}\n`)
  if (subtitle) {
    output.write(`${c.green(symBar())} ${c.dim(subtitle)}\n`)
  }
  output.write(`${c.green(symBar())}\n`)
}

/** Closing line shown once at the end of the wizard. */
export function outro(message: string): void {
  output.write(`${c.green(symBar())}\n`)
  output.write(`${c.green(symCheck())} ${message}\n\n`)
}

/** Collapsed one-line summary of an answered question. */
export function summary(label: string, value: string): void {
  output.write(`${c.green(symCheck())} ${c.dim(label)}  ${c.cyan(value)}\n`)
}

export interface SelectChoice<T extends string> {
  value: T
  /** Visible label; defaults to `value`. */
  label?: string
  /** Dim hint shown to the right of the focused row. */
  hint?: string
}

export interface SelectOptions<T extends string> {
  message: string
  choices: SelectChoice<T>[]
  defaultValue: T
}

/**
 * Interactive single-choice prompt driven by arrow keys (or j/k). Resolves with
 * the selected choice value. Must only be called in an interactive TTY.
 */
export function selectPrompt<T extends string>(opts: SelectOptions<T>): Promise<T> {
  if (!isInteractiveTTY()) {
    throw new Error('selectPrompt requires an interactive TTY.')
  }

  const { message, choices } = opts
  if (choices.length === 0) {
    throw new Error('selectPrompt requires at least one choice.')
  }

  const startIndex = Math.max(
    0,
    choices.findIndex((ch) => ch.value === opts.defaultValue),
  )

  return new Promise<T>((resolve, reject) => {
    let index = startIndex
    let rendered = 0

    const lineFor = (ch: SelectChoice<T>, active: boolean): string => {
      const label = ch.label ?? ch.value
      if (active) {
        const hint = ch.hint ? ` ${c.dim(ch.hint)}` : ''
        return `${c.cyan(symPointer())} ${c.cyan(c.underline(label))}${hint}`
      }
      return `  ${c.dim(label)}`
    }

    const clearRendered = () => {
      if (rendered > 0) {
        output.write(`\x1b[${rendered}A`)
      }
      output.write('\x1b[J')
    }

    const render = () => {
      clearRendered()
      const lines = [
        `${c.green(symQuestion())} ${c.bold(message)}`,
        ...choices.map((ch, i) => lineFor(ch, i === index)),
      ]
      output.write(`${lines.join('\n')}\n`)
      rendered = lines.length
    }

    const cleanup = () => {
      input.off('keypress', onKey)
      if (input.isTTY && typeof input.setRawMode === 'function') {
        input.setRawMode(false)
      }
      input.pause()
      output.write('\x1b[?25h') // show cursor
    }

    const finish = () => {
      clearRendered()
      cleanup()
      const chosen = choices[index]
      summary(message, chosen.label ?? chosen.value)
      resolve(chosen.value)
    }

    const onKey = (_str: string, key: readline.Key) => {
      if (!key) return
      if (key.ctrl && key.name === 'c') {
        clearRendered()
        cleanup()
        output.write('\n')
        reject(new Error('Cancelled.'))
        return
      }
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + choices.length) % choices.length
        render()
      } else if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % choices.length
        render()
      } else if (key.name === 'return' || key.name === 'enter') {
        finish()
      }
    }

    readline.emitKeypressEvents(input)
    if (input.isTTY && typeof input.setRawMode === 'function') {
      input.setRawMode(true)
    }
    input.resume()
    output.write('\x1b[?25l') // hide cursor
    input.on('keypress', onKey)
    render()
  })
}

/** Interactive yes/no prompt rendered as a two-row arrow-key selection. */
export async function confirmPrompt(message: string, defaultValue: boolean): Promise<boolean> {
  const value = await selectPrompt<'yes' | 'no'>({
    message,
    defaultValue: defaultValue ? 'yes' : 'no',
    choices: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  })
  return value === 'yes'
}
