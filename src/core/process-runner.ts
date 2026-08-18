import { type SpawnOptionsWithoutStdio, spawn } from 'node:child_process'

import { createStreamingScrubber } from './scrub.js'
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

export interface ProcessOutputPolicy {
  /** Scrub credential context before the irreversible output-tail cap is applied. */
  scrubOptions: ScrubOptions
}

class ScrubbedOutputTail {
  readonly #scrubber
  #tail: Buffer = Buffer.alloc(0)
  #tailTruncated = false
  #rawBytes = 0

  constructor(options: ScrubOptions) {
    this.#scrubber = createStreamingScrubber(options)
  }

  append(chunk: Buffer | string): void {
    const bytes = Buffer.from(chunk)
    this.#rawBytes += bytes.length
    this.#appendSafe(this.#scrubber.write(bytes))
  }

  finish(): { value: string; truncated: boolean } {
    this.#appendSafe(this.#scrubber.end())
    return {
      value: decodeOutputTail(this.#tail),
      truncated: this.#rawBytes > PROCESS_OUTPUT_TAIL_BYTES || this.#tailTruncated,
    }
  }

  #appendSafe(value: string): void {
    if (!value) return
    const output = appendOutputTail(this.#tail, value)
    this.#tail = output.tail
    this.#tailTruncated ||= output.truncated
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
