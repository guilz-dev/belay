import { type SpawnOptionsWithoutStdio, spawn } from 'node:child_process'

export interface ShellRunResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout?: string
  stderr?: string
}

const PROCESS_OUTPUT_TAIL_BYTES = 16_384
const EXIT_OUTPUT_GRACE_MS = 25
const TIMEOUT_KILL_GRACE_MS = 250
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000

function appendOutputTail(current: Buffer, chunk: Buffer | string): Buffer {
  const next = Buffer.concat([current, Buffer.from(chunk)])
  return next.length > PROCESS_OUTPUT_TAIL_BYTES ? next.subarray(-PROCESS_OUTPUT_TAIL_BYTES) : next
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
    let timedOut = false
    let settled = false
    let windowsCleanupPending = false
    let exitTimer: NodeJS.Timeout | undefined

    child.stdout.on('data', (chunk) => {
      stdout = appendOutputTail(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendOutputTail(stderr, chunk)
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
      resolve({
        exitCode,
        signal: signal ? String(signal) : null,
        timedOut,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
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
      stderr = appendOutputTail(stderr, error.message)
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
