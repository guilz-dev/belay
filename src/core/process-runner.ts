import { type SpawnOptionsWithoutStdio, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

import { scrubString } from './scrub.js'
import type { ScrubOptions } from './types.js'

export interface ShellRunResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

const PROCESS_OUTPUT_TAIL_BYTES = 16_384
const EXIT_OUTPUT_GRACE_MS = 25
const TIMEOUT_KILL_GRACE_MS = 250
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000
const SCRUB_INPUT_SLICE_BYTES = 4_096

export interface ProcessOutputPolicy {
  /** Scrub credential context before the irreversible output-tail cap is applied. */
  scrubOptions: ScrubOptions
}

type SensitiveContinuation =
  | 'non_whitespace'
  | 'double_quote'
  | 'single_quote'
  | 'secret_value'
  | 'bearer'
  | 'high_entropy'
  | 'url_credentials'

interface OngoingSensitiveValue {
  index: number
  replacement: string
  continuation: SensitiveContinuation
}

function firstMatch(
  value: string,
  pattern: RegExp,
  replacement: (match: RegExpExecArray) => string,
  continuation: SensitiveContinuation,
): OngoingSensitiveValue | null {
  const match = pattern.exec(value)
  return match ? { index: match.index, replacement: replacement(match), continuation } : null
}

function incompleteSensitiveValue(
  value: string,
  options: ScrubOptions,
): OngoingSensitiveValue | null {
  if (options.maskAuthHeaders !== false) {
    const doubleQuoted = firstMatch(
      value,
      /"Authorization:\s*(?:Bearer|Basic|Token)?\s*[^"]+$/i,
      () => '"Authorization: <redacted>',
      'double_quote',
    )
    if (doubleQuoted) return doubleQuoted
    const singleQuoted = firstMatch(
      value,
      /'Authorization:\s*(?:Bearer|Basic|Token)?\s*[^']+$/i,
      () => "'Authorization: <redacted>",
      'single_quote',
    )
    if (singleQuoted) return singleQuoted
    const doubleGeneric = firstMatch(
      value,
      /"(X-Api-Key|X-Auth-Token|Private-Token):\s*[^"]+$/i,
      (match) => `"${match[1]}: <redacted>`,
      'double_quote',
    )
    if (doubleGeneric) return doubleGeneric
    const singleGeneric = firstMatch(
      value,
      /'(X-Api-Key|X-Auth-Token|Private-Token):\s*[^']+$/i,
      (match) => `'${match[1]}: <redacted>`,
      'single_quote',
    )
    if (singleGeneric) return singleGeneric
  }

  if (options.maskKeyValueSecrets !== false) {
    const urlCredentials = firstMatch(
      value,
      /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)$/,
      (match) => `${match[1]}<redacted>:<redacted>`,
      'url_credentials',
    )
    if (urlCredentials) return urlCredentials
  }
  return null
}

function continuationFromScrubbed(raw: string, scrubbed: string): SensitiveContinuation | null {
  if (raw === scrubbed) return null
  if (scrubbed.endsWith('/belay-approve <approval-id>')) return 'non_whitespace'
  if (scrubbed.endsWith('Bearer <redacted>')) return 'bearer'
  if (scrubbed.endsWith('<high-entropy>')) return 'high_entropy'
  if (scrubbed.endsWith('<redacted>')) return 'secret_value'
  return null
}

function continuationEnd(value: string, continuation: SensitiveContinuation): number {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ''
    if (continuation === 'double_quote' && character === '"') return index
    if (continuation === 'single_quote' && character === "'") return index
    if (continuation === 'non_whitespace' && /\s/.test(character)) return index
    if (continuation === 'secret_value' && /[\s'"]/.test(character)) return index
    if (continuation === 'bearer' && !/[A-Za-z0-9._~+/=-]/.test(character)) return index
    if (continuation === 'high_entropy' && !/[A-Za-z0-9+/=]/.test(character)) return index
    if (continuation === 'url_credentials' && /[@\s/]/.test(character)) return index
  }
  return -1
}

class ScrubbedOutputTail {
  readonly #decoder = new StringDecoder('utf8')
  readonly #options: ScrubOptions
  #buffer = ''
  #continuation: SensitiveContinuation | null = null
  #rawBytes = 0

  constructor(options: ScrubOptions) {
    this.#options = options
  }

  append(chunk: Buffer | string): void {
    const bytes = Buffer.from(chunk)
    this.#rawBytes += bytes.length
    for (let offset = 0; offset < bytes.length; offset += SCRUB_INPUT_SLICE_BYTES) {
      this.#appendDecoded(
        this.#decoder.write(bytes.subarray(offset, offset + SCRUB_INPUT_SLICE_BYTES)),
      )
    }
  }

  finish(): { value: string; truncated: boolean } {
    this.#appendDecoded(this.#decoder.end())
    this.#scrubAndCap(true)
    return { value: this.#buffer, truncated: this.#rawBytes > PROCESS_OUTPUT_TAIL_BYTES }
  }

  #appendDecoded(value: string): void {
    if (!value) return
    if (this.#continuation) {
      const end = continuationEnd(value, this.#continuation)
      if (end < 0) return
      this.#continuation = null
      value = value.slice(end)
    }
    this.#buffer += value
    if (Buffer.byteLength(this.#buffer) > PROCESS_OUTPUT_TAIL_BYTES) {
      this.#scrubAndCap(false)
    }
  }

  #scrubAndCap(final: boolean): void {
    const incomplete = incompleteSensitiveValue(this.#buffer, this.#options)
    const scrubbed = incomplete
      ? `${scrubString(this.#buffer.slice(0, incomplete.index), this.#options)}${incomplete.replacement}`
      : scrubString(this.#buffer, this.#options)
    const continuation =
      incomplete?.continuation ?? continuationFromScrubbed(this.#buffer, scrubbed)
    const encoded = Buffer.from(scrubbed)
    const tail =
      encoded.length > PROCESS_OUTPUT_TAIL_BYTES
        ? encoded.subarray(-PROCESS_OUTPUT_TAIL_BYTES)
        : encoded
    this.#buffer = decodeOutputTail(tail)
    this.#continuation = final ? null : continuation
  }
}

function appendOutputTail(
  current: Buffer,
  chunk: Buffer | string,
): {
  tail: Buffer
  truncated: boolean
} {
  const next = Buffer.concat([current, Buffer.from(chunk)])
  return {
    tail:
      next.length > PROCESS_OUTPUT_TAIL_BYTES ? next.subarray(-PROCESS_OUTPUT_TAIL_BYTES) : next,
    truncated: next.length > PROCESS_OUTPUT_TAIL_BYTES,
  }
}

function decodeOutputTail(tail: Buffer): string {
  for (let offset = 0; offset <= Math.min(3, tail.length); offset += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(tail.subarray(offset))
    } catch {
      // A byte cap may have cut a leading multi-byte character; try its next boundary.
    }
  }
  return tail.toString('utf8')
}

export function windowsProcessTreeKillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/t', '/f']
}

function forceKillWindowsProcessTree(pid: number, fallback: () => void): Promise<void> {
  return new Promise((resolve) => {
    const taskkill = spawn('taskkill', windowsProcessTreeKillArgs(pid), {
      stdio: 'ignore',
      windowsHide: true,
    })
    let settled = false
    const finish = (succeeded: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (!succeeded) {
        fallback()
      }
      resolve()
    }
    const timer = setTimeout(() => {
      taskkill.kill()
      finish(false)
    }, WINDOWS_TASKKILL_TIMEOUT_MS)
    taskkill.on('error', () => finish(false))
    taskkill.on('close', (code) => finish(code === 0))
  })
}

export function runProcessWithBoundedOutput(
  file: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  timeoutMs: number,
  outputPolicy?: ProcessOutputPolicy,
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const detached = process.platform !== 'win32'
    const child = spawn(file, args, {
      ...options,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout: Buffer = Buffer.alloc(0)
    let stderr: Buffer = Buffer.alloc(0)
    let stdoutTruncated = false
    let stderrTruncated = false
    const scrubbedStdout = outputPolicy
      ? new ScrubbedOutputTail(outputPolicy.scrubOptions)
      : undefined
    const scrubbedStderr = outputPolicy
      ? new ScrubbedOutputTail(outputPolicy.scrubOptions)
      : undefined
    let timedOut = false
    let settled = false
    let windowsCleanupPending = false
    let exitTimer: NodeJS.Timeout | undefined

    child.stdout.on('data', (chunk) => {
      if (scrubbedStdout) {
        scrubbedStdout.append(chunk)
        return
      }
      const output = appendOutputTail(stdout, chunk)
      stdout = output.tail
      stdoutTruncated ||= output.truncated
    })
    child.stderr.on('data', (chunk) => {
      if (scrubbedStderr) {
        scrubbedStderr.append(chunk)
        return
      }
      const output = appendOutputTail(stderr, chunk)
      stderr = output.tail
      stderrTruncated ||= output.truncated
    })

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutTimer)
      if (exitTimer) {
        clearTimeout(exitTimer)
      }
      child.stdout.destroy()
      child.stderr.destroy()
      const safeStdout = scrubbedStdout?.finish()
      const safeStderr = scrubbedStderr?.finish()
      resolve({
        exitCode,
        signal: signal ? String(signal) : null,
        timedOut,
        stdout: safeStdout?.value ?? decodeOutputTail(stdout),
        stderr: safeStderr?.value ?? decodeOutputTail(stderr),
        stdoutTruncated: safeStdout?.truncated ?? stdoutTruncated,
        stderrTruncated: safeStderr?.truncated ?? stderrTruncated,
      })
    }

    const kill = (signal: NodeJS.Signals) => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, signal)
          return
        }
        child.kill(signal)
      } catch {
        // The process may already have exited between the state check and kill.
      }
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && child.pid) {
        windowsCleanupPending = true
        void forceKillWindowsProcessTree(child.pid, () => child.kill('SIGKILL')).then(() => {
          windowsCleanupPending = false
          finish(child.exitCode, child.signalCode ?? 'SIGKILL')
        })
        return
      }
      kill('SIGTERM')
      setTimeout(() => {
        kill('SIGKILL')
        finish(null, 'SIGKILL')
      }, TIMEOUT_KILL_GRACE_MS)
    }, timeoutMs)

    child.on('error', (error) => {
      if (scrubbedStderr) {
        scrubbedStderr.append(error.message)
        finish(1, null)
        return
      }
      const output = appendOutputTail(stderr, error.message)
      stderr = output.tail
      stderrTruncated ||= output.truncated
      finish(1, null)
    })
    child.on('exit', (exitCode, signal) => {
      clearTimeout(timeoutTimer)
      if (windowsCleanupPending) {
        return
      }
      exitTimer = setTimeout(() => finish(exitCode, signal), EXIT_OUTPUT_GRACE_MS)
    })
    child.on('close', (exitCode, signal) => {
      if (windowsCleanupPending) {
        return
      }
      finish(exitCode, signal)
    })
  })
}
