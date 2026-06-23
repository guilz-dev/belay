import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CliJudgeRunCommand } from './judge-cli.js'
import { runCliJsonWithTimeouts } from './judge-cli.js'
import type { BelayJudgeSessionConfig } from './judge-runtime-config.js'
import { normalizeJudgeSessionConfig } from './judge-runtime-config.js'
import {
  type BrokerEvaluateRequest,
  type BrokerEvaluateResult,
  getRepoJudgeSessionBroker,
  JudgeSessionBroker,
  resetJudgeSessionBrokersForTests,
  stopRepoJudgeSessionBroker,
} from './judge-session-broker.js'
import type { JudgeSessionResetReason } from './judge-session-guard.js'

export const JUDGE_BROKER_SOCKET = 'judge-broker.sock'
export const JUDGE_BROKER_STATUS = 'judge-broker.json'
export const JUDGE_BROKER_PID = 'judge-broker.pid'
export const JUDGE_BROKER_SESSION = 'judge-broker-session.json'

export interface JudgeBrokerStatus {
  pid: number
  repoRoot: string
  socketPath: string
  startedAt: string
}

export interface JudgeBrokerPaths {
  stateDir: string
  socketPath: string
  statusPath: string
  pidPath: string
  sessionConfigPath: string
}

export function judgeBrokerPaths(stateDir: string): JudgeBrokerPaths {
  return {
    stateDir,
    socketPath: path.join(stateDir, JUDGE_BROKER_SOCKET),
    statusPath: path.join(stateDir, JUDGE_BROKER_STATUS),
    pidPath: path.join(stateDir, JUDGE_BROKER_PID),
    sessionConfigPath: path.join(stateDir, JUDGE_BROKER_SESSION),
  }
}

function daemonScriptPath(): string {
  return fileURLToPath(new URL('../../judge-broker-daemon.js', import.meta.url))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function useInProcessBroker(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST || env.VITEST_WORKER_ID || env.BELAY_JUDGE_BROKER_IN_PROCESS === '1')
}

async function readBrokerStatus(statusPath: string): Promise<JudgeBrokerStatus | null> {
  if (!existsSync(statusPath)) {
    return null
  }
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(statusPath, 'utf8')) as JudgeBrokerStatus
    if (typeof raw.pid !== 'number' || typeof raw.socketPath !== 'string') {
      return null
    }
    return raw
  } catch {
    return null
  }
}

async function readBrokerSessionConfig(
  sessionConfigPath: string,
): Promise<BelayJudgeSessionConfig | null> {
  if (!existsSync(sessionConfigPath)) {
    return null
  }
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(
      await readFile(sessionConfigPath, 'utf8'),
    ) as Partial<BelayJudgeSessionConfig>
    return normalizeJudgeSessionConfig({ ...raw, enabled: true })
  } catch {
    return null
  }
}

function brokerSessionConfigPayload(sessionConfig: BelayJudgeSessionConfig): string {
  return JSON.stringify(normalizeJudgeSessionConfig({ ...sessionConfig, enabled: true }))
}

async function writeBrokerSessionConfig(
  paths: JudgeBrokerPaths,
  sessionConfig: BelayJudgeSessionConfig,
): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(paths.sessionConfigPath, brokerSessionConfigPayload(sessionConfig), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

async function connectBrokerSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('judge broker connect timed out'))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function rpcEvaluate(
  socketPath: string,
  request: BrokerEvaluateRequest,
  timeoutMs: number,
  connectTimeoutMs: number,
): Promise<BrokerEvaluateResult> {
  const socket = await connectBrokerSocket(socketPath, connectTimeoutMs)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const payload = JSON.stringify({
    type: 'evaluate',
    id,
    request,
    timeoutMs,
  })

  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('judge broker evaluate timed out'))
    }, timeoutMs + connectTimeoutMs)

    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        try {
          const message = JSON.parse(line) as {
            type: string
            id: string
            result?: BrokerEvaluateResult
            error?: string
          }
          if (message.id !== id) {
            continue
          }
          clearTimeout(timer)
          socket.destroy()
          if (message.type === 'error') {
            reject(new Error(message.error ?? 'judge broker error'))
            return
          }
          if (message.result) {
            resolve(message.result)
          }
        } catch {
          // wait for more data
        }
      }
    }

    socket.on('data', onData)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.write(`${payload}\n`)
  })
}

export async function ensureJudgeBrokerDaemon(
  stateDir: string,
  repoRoot: string,
  sessionConfig: BelayJudgeSessionConfig,
): Promise<JudgeBrokerPaths> {
  const paths = judgeBrokerPaths(stateDir)
  const brokerSessionConfig = normalizeJudgeSessionConfig({ ...sessionConfig, enabled: true })
  const nextConfigPayload = brokerSessionConfigPayload(brokerSessionConfig)
  const existingConfig = await readBrokerSessionConfig(paths.sessionConfigPath)
  const configChanged =
    existingConfig !== null && brokerSessionConfigPayload(existingConfig) !== nextConfigPayload

  const status = await readBrokerStatus(paths.statusPath)
  if (status && isProcessAlive(status.pid) && existsSync(paths.socketPath) && !configChanged) {
    await writeBrokerSessionConfig(paths, brokerSessionConfig)
    return paths
  }

  if (status?.pid && isProcessAlive(status.pid)) {
    await stopJudgeBrokerDaemon(stateDir)
  } else {
    await cleanupJudgeBrokerArtifacts(paths)
  }

  await writeBrokerSessionConfig(paths, brokerSessionConfig)

  const child = spawn(process.execPath, [daemonScriptPath()], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      BELAY_JUDGE_BROKER_REPO_ROOT: repoRoot,
      BELAY_JUDGE_BROKER_STATE_DIR: stateDir,
    },
  })
  child.unref()

  const deadline = Date.now() + sessionConfig.connectTimeoutMs
  while (Date.now() < deadline) {
    if (existsSync(paths.socketPath)) {
      const live = await readBrokerStatus(paths.statusPath)
      if (live && isProcessAlive(live.pid)) {
        return paths
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error('judge broker daemon failed to start')
}

export async function cleanupJudgeBrokerArtifacts(paths: JudgeBrokerPaths): Promise<void> {
  for (const artifact of [
    paths.socketPath,
    paths.statusPath,
    paths.pidPath,
    paths.sessionConfigPath,
  ]) {
    if (existsSync(artifact)) {
      await unlink(artifact).catch(() => undefined)
    }
  }
}

export async function stopJudgeBrokerDaemon(stateDir: string): Promise<number> {
  const paths = judgeBrokerPaths(stateDir)
  const status = await readBrokerStatus(paths.statusPath)
  if (status?.pid && isProcessAlive(status.pid)) {
    try {
      process.kill(status.pid, 'SIGTERM')
    } catch {
      // already stopped
    }
  }
  await cleanupJudgeBrokerArtifacts(paths)
  return status?.pid ? 1 : 0
}

export async function evaluateViaJudgeBroker(options: {
  stateDir: string
  repoRoot: string
  sessionConfig: BelayJudgeSessionConfig
  request: BrokerEvaluateRequest
  timeoutMs: number
  runCommand?: CliJudgeRunCommand
}): Promise<BrokerEvaluateResult> {
  const runCommand: CliJudgeRunCommand =
    options.runCommand ??
    ((invocation, timeout) => runCliJsonWithTimeouts(invocation, { evalTimeoutMs: timeout }))

  if (useInProcessBroker()) {
    const broker = getRepoJudgeSessionBroker(options.repoRoot, {
      config: options.sessionConfig,
      runCommand,
    })
    return broker.evaluate(options.request, options.timeoutMs)
  }

  const paths = await ensureJudgeBrokerDaemon(
    options.stateDir,
    options.repoRoot,
    options.sessionConfig,
  )
  return rpcEvaluate(
    paths.socketPath,
    options.request,
    options.timeoutMs,
    options.sessionConfig.connectTimeoutMs,
  )
}

export function resetJudgeBrokerForTests(): void {
  resetJudgeSessionBrokersForTests()
}

async function rpcInvalidate(
  socketPath: string,
  sessionKey: string,
  reason: JudgeSessionResetReason,
  connectTimeoutMs: number,
): Promise<void> {
  const socket = await connectBrokerSocket(socketPath, connectTimeoutMs)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const payload = JSON.stringify({ type: 'invalidate', id, sessionKey, reason })

  await new Promise<void>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('judge broker invalidate timed out'))
    }, connectTimeoutMs)

    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        try {
          const message = JSON.parse(line) as { type: string; id: string }
          if (message.id !== id) {
            continue
          }
          clearTimeout(timer)
          socket.destroy()
          resolve()
        } catch {
          // wait for more data
        }
      }
    }

    socket.on('data', onData)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.write(`${payload}\n`)
  })
}

export async function invalidateJudgeSession(options: {
  stateDir: string
  repoRoot: string
  sessionConfig: BelayJudgeSessionConfig
  sessionKey: string
  reason: JudgeSessionResetReason
}): Promise<void> {
  if (useInProcessBroker()) {
    const broker = getRepoJudgeSessionBroker(options.repoRoot, {
      config: { ...options.sessionConfig, enabled: true },
      runCommand: (invocation, timeout) =>
        runCliJsonWithTimeouts(invocation, { evalTimeoutMs: timeout }),
    })
    broker.invalidateSession(options.sessionKey, options.reason)
    return
  }

  const paths = await ensureJudgeBrokerDaemon(
    options.stateDir,
    options.repoRoot,
    options.sessionConfig,
  )
  await rpcInvalidate(
    paths.socketPath,
    options.sessionKey,
    options.reason,
    options.sessionConfig.connectTimeoutMs,
  )
}

export { JudgeSessionBroker, stopRepoJudgeSessionBroker }
