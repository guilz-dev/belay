import { spawn } from 'node:child_process'
import path from 'node:path'

export const DEFAULT_CLI_REPLAY_TIMEOUT_MS = 300_000

export async function replayShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_CLI_REPLAY_TIMEOUT_MS,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }> {
  const resolvedCwd = path.resolve(cwd)
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: resolvedCwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(timedOut ? { timedOut: true } : {}),
      })
    })
  })
}
