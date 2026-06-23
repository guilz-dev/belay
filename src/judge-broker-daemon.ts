import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import {
  cleanupJudgeBrokerArtifacts,
  JUDGE_BROKER_SESSION,
  type JudgeBrokerStatus,
  judgeBrokerPaths,
} from './core/verdict/judge-broker-service.js'
import { runCliJsonWithTimeouts } from './core/verdict/judge-cli.js'
import {
  type BelayJudgeSessionConfig,
  DEFAULT_JUDGE_SESSION_CONFIG,
  normalizeJudgeSessionConfig,
  resolveSessionEvalTimeoutMs,
} from './core/verdict/judge-runtime-config.js'
import {
  type BrokerEvaluateRequest,
  JudgeSessionBroker,
} from './core/verdict/judge-session-broker.js'
import type { JudgeSessionResetReason } from './core/verdict/judge-session-guard.js'

async function loadBrokerSessionConfig(stateDir: string): Promise<BelayJudgeSessionConfig> {
  const sessionConfigPath = path.join(stateDir, JUDGE_BROKER_SESSION)
  try {
    const raw = JSON.parse(
      await readFile(sessionConfigPath, 'utf8'),
    ) as Partial<BelayJudgeSessionConfig>
    return normalizeJudgeSessionConfig({ ...raw, enabled: true })
  } catch {
    return normalizeJudgeSessionConfig({ ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true })
  }
}

async function main(): Promise<void> {
  const repoRoot = process.env.BELAY_JUDGE_BROKER_REPO_ROOT
  const stateDir = process.env.BELAY_JUDGE_BROKER_STATE_DIR
  if (!repoRoot || !stateDir) {
    process.stderr.write(
      'BELAY_JUDGE_BROKER_REPO_ROOT and BELAY_JUDGE_BROKER_STATE_DIR are required.\n',
    )
    process.exitCode = 1
    return
  }

  const paths = judgeBrokerPaths(stateDir)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })

  const sessionConfig = await loadBrokerSessionConfig(stateDir)
  const defaultEvalTimeoutMs = resolveSessionEvalTimeoutMs(sessionConfig, 25_000)

  const broker = new JudgeSessionBroker({
    config: sessionConfig,
    runCommand: (invocation, timeoutMs) =>
      runCliJsonWithTimeouts(invocation, { evalTimeoutMs: timeoutMs }),
  })

  let idleTimer: NodeJS.Timeout | null = null
  let server: Server

  const scheduleIdleShutdown = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
    }
    idleTimer = setTimeout(() => {
      void shutdown('idle_timeout')
    }, sessionConfig.maxIdleMs)
  }

  const shutdown = async (reason: string) => {
    broker.stopAll('manual_stop')
    server?.close()
    await cleanupJudgeBrokerArtifacts(paths)
    process.stderr.write(`judge broker stopped (${reason})\n`)
    process.exit(0)
  }

  server = createServer((socket: Socket) => {
    scheduleIdleShutdown()
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        void handleLine(line, socket, broker, defaultEvalTimeoutMs).catch((error) => {
          const id = safeMessageId(line)
          socket.write(
            `${JSON.stringify({
              type: 'error',
              id,
              error: error instanceof Error ? error.message : 'judge broker handler failed',
            })}\n`,
          )
        })
      }
    })
  })

  await unlink(paths.socketPath).catch(() => undefined)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(paths.socketPath, () => resolve())
  })

  const status: JudgeBrokerStatus = {
    pid: process.pid,
    repoRoot: path.resolve(repoRoot),
    socketPath: paths.socketPath,
    startedAt: new Date().toISOString(),
  }
  await writeFile(paths.statusPath, JSON.stringify(status), { encoding: 'utf8', mode: 0o600 })
  await writeFile(paths.pidPath, String(process.pid), { encoding: 'utf8', mode: 0o600 })

  process.on('SIGTERM', () => {
    void shutdown('sigterm')
  })
  process.on('SIGINT', () => {
    void shutdown('sigint')
  })

  scheduleIdleShutdown()
  process.stdout.write(`judge broker listening on ${paths.socketPath} for ${repoRoot}\n`)
}

function safeMessageId(line: string): string {
  try {
    const parsed = JSON.parse(line) as { id?: string }
    return parsed.id ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

async function handleLine(
  line: string,
  socket: Socket,
  broker: JudgeSessionBroker,
  defaultEvalTimeoutMs: number,
): Promise<void> {
  const message = JSON.parse(line) as {
    type: string
    id: string
    request?: BrokerEvaluateRequest
    timeoutMs?: number
    sessionKey?: string
    reason?: JudgeSessionResetReason
  }

  if (message.type === 'stop') {
    socket.write(`${JSON.stringify({ type: 'stopped', id: message.id })}\n`)
    broker.stopAll('manual_stop')
    return
  }

  if (message.type === 'invalidate' && typeof message.sessionKey === 'string') {
    broker.invalidateSession(message.sessionKey, message.reason ?? 'parse_failure')
    socket.write(`${JSON.stringify({ type: 'invalidated', id: message.id })}\n`)
    return
  }

  if (message.type !== 'evaluate' || !message.request) {
    socket.write(
      `${JSON.stringify({ type: 'error', id: message.id, error: 'unsupported message' })}\n`,
    )
    return
  }

  const result = await broker.evaluate(message.request, message.timeoutMs ?? defaultEvalTimeoutMs)
  socket.write(`${JSON.stringify({ type: 'result', id: message.id, result })}\n`)
}

await main()
