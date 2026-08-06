import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from 'node:child_process'

import type { CliInvocation, CliJudgeRunCommand } from './judge-cli.js'

type JsonRpcId = number | string

interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface AcpSessionResponse {
  sessionId: string
  models?: {
    currentModelId?: string
    availableModels?: Array<{ modelId?: string }>
  }
  configOptions?: Array<{
    id?: string
    currentValue?: string
    options?: Array<{ value?: string }>
  }>
}

export type CursorAcpSpawn = (
  binary: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams

export type CursorAcpErrorKind =
  | 'connect_timeout'
  | 'eval_timeout'
  | 'process_exit'
  | 'protocol_error'

export class CursorAcpError extends Error {
  constructor(
    readonly kind: CursorAcpErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'CursorAcpError'
  }
}

export interface CursorAcpJudgeRunnerOptions {
  cwd: string
  connectTimeoutMs: number
  binary?: string
  spawnProcess?: CursorAcpSpawn
}

const STDERR_TAIL_LIMIT = 2_048
const TERMINATE_GRACE_MS = 250

function invocationValue(invocation: CliInvocation, flag: string): string | undefined {
  const index = invocation.args.indexOf(flag)
  return index >= 0 ? invocation.args[index + 1] : undefined
}

function promptFromInvocation(invocation: CliInvocation): string {
  if (invocation.stdin !== undefined) {
    return invocation.stdin
  }
  return invocation.args[invocation.args.length - 1] ?? ''
}

function modelIdsFromSession(session: AcpSessionResponse): string[] {
  const fromModels = session.models?.availableModels
    ?.map((entry) => entry.modelId)
    .filter((value): value is string => Boolean(value))
  if (fromModels?.length) {
    return fromModels
  }
  const modelOption = session.configOptions?.find((option) => option.id === 'model')
  return (
    modelOption?.options
      ?.map((entry) => entry.value)
      .filter((value): value is string => Boolean(value)) ?? []
  )
}

export function resolveCursorAcpModelId(requested: string, session: AcpSessionResponse): string {
  const available = modelIdsFromSession(session)
  if (available.includes(requested)) {
    return requested
  }
  const parameterized = available.find((modelId) => modelId.startsWith(`${requested}[`))
  return parameterized ?? requested
}

export class CursorAcpJudgeRunner {
  private readonly binary: string
  private readonly spawnProcess: CursorAcpSpawn
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private connected = false
  private nextId = 0
  private stdoutBuffer = ''
  private stderrTail = ''
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly messageBuffers = new Map<string, string>()
  private activeSessionId: string | null = null

  constructor(private readonly options: CursorAcpJudgeRunnerOptions) {
    this.binary = options.binary ?? 'cursor-agent'
    this.spawnProcess = options.spawnProcess ?? spawn
  }

  get sessionId(): string | null {
    return this.activeSessionId
  }

  readonly run: CliJudgeRunCommand = async (invocation, timeoutMs) => {
    if (invocation.binary !== this.binary && invocation.binary !== 'cursor-agent') {
      throw new CursorAcpError(
        'protocol_error',
        `Cursor ACP runner cannot execute ${invocation.binary}`,
      )
    }

    let totalTimer: NodeJS.Timeout | null = null
    try {
      const evaluation = this.evaluate(invocation, timeoutMs)
      const totalTimeout = new Promise<never>((_resolve, reject) => {
        totalTimer = setTimeout(() => {
          reject(new CursorAcpError('eval_timeout', 'Cursor ACP evaluation timed out'))
        }, timeoutMs)
      })
      return await Promise.race([evaluation, totalTimeout])
    } catch (error) {
      if (error instanceof CursorAcpError && error.kind === 'eval_timeout') {
        this.notify('session/cancel', { sessionId: this.activeSessionId })
      }
      await this.stop()
      throw error
    } finally {
      if (totalTimer) {
        clearTimeout(totalTimer)
      }
    }
  }

  private async evaluate(invocation: CliInvocation, timeoutMs: number): Promise<string> {
    await this.ensureConnected()
    const requestedResumeId = invocationValue(invocation, '--resume')
    const model = invocationValue(invocation, '--model') ?? 'composer-2.5'
    const canReuse = Boolean(requestedResumeId) && requestedResumeId === this.activeSessionId

    if (!canReuse) {
      await this.createSession(model)
    }

    const sessionId = this.activeSessionId
    if (!sessionId) {
      throw new CursorAcpError('protocol_error', 'Cursor ACP session was not created')
    }

    this.messageBuffers.set(sessionId, '')
    try {
      await this.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: promptFromInvocation(invocation) }],
        },
        timeoutMs,
        'eval_timeout',
      )
      const raw = this.messageBuffers.get(sessionId)?.trim() ?? ''
      if (!raw) {
        throw new CursorAcpError('protocol_error', 'Cursor ACP returned no agent message')
      }
      return raw
    } finally {
      this.messageBuffers.delete(sessionId)
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.connected = false
    this.startPromise = null
    this.activeSessionId = null
    this.stdoutBuffer = ''
    this.messageBuffers.clear()
    this.rejectPending(
      new CursorAcpError('process_exit', this.withStderr('Cursor ACP process stopped')),
    )
    if (child && child.exitCode === null) {
      await this.terminateChild(child)
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.child) {
      return
    }
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null
      })
    }
    await this.startPromise
  }

  private async start(): Promise<void> {
    this.stderrTail = ''
    const child = this.spawnProcess(this.binary, ['acp'], {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.on('data', (chunk) => this.handleStdout(String(chunk)))
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_LIMIT)
    })
    child.once('error', (error) => {
      this.handleProcessExit(
        new CursorAcpError('process_exit', this.withStderr(error.message)),
        child,
      )
    })
    child.once('close', (code) => {
      this.handleProcessExit(
        new CursorAcpError(
          'process_exit',
          this.withStderr(`Cursor ACP exited with code ${code ?? 'unknown'}`),
        ),
        child,
      )
    })

    try {
      await this.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: 'belay-judge',
            title: 'Belay Judge',
            version: '1',
          },
        },
        this.options.connectTimeoutMs,
        'connect_timeout',
      )
      await this.request(
        'authenticate',
        { methodId: 'cursor_login' },
        this.options.connectTimeoutMs,
        'connect_timeout',
      )
      this.connected = true
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  private async createSession(model: string): Promise<void> {
    const previous = this.activeSessionId
    this.activeSessionId = null
    if (previous) {
      await this.request(
        'session/close',
        { sessionId: previous },
        Math.min(this.options.connectTimeoutMs, 1_000),
        'connect_timeout',
      ).catch(() => undefined)
    }

    const session = (await this.request(
      'session/new',
      { cwd: this.options.cwd, mcpServers: [] },
      this.options.connectTimeoutMs,
      'connect_timeout',
    )) as AcpSessionResponse
    if (!session?.sessionId) {
      throw new CursorAcpError('protocol_error', 'Cursor ACP session/new omitted sessionId')
    }

    this.activeSessionId = session.sessionId
    await this.request(
      'session/set_config_option',
      { sessionId: session.sessionId, configId: 'mode', value: 'ask' },
      this.options.connectTimeoutMs,
      'connect_timeout',
    )
    await this.request(
      'session/set_config_option',
      {
        sessionId: session.sessionId,
        configId: 'model',
        value: resolveCursorAcpModelId(model, session),
      },
      this.options.connectTimeoutMs,
      'connect_timeout',
    )
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    timeoutKind: 'connect_timeout' | 'eval_timeout',
  ): Promise<unknown> {
    const child = this.child
    if (!child?.stdin.writable) {
      return Promise.reject(
        new CursorAcpError('process_exit', this.withStderr('Cursor ACP stdin is unavailable')),
      )
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CursorAcpError(timeoutKind, `Cursor ACP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) {
      return
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage)
      } catch {
        const child = this.child
        this.handleProcessExit(
          new CursorAcpError('protocol_error', 'Cursor ACP emitted invalid JSON-RPC'),
          child,
        )
        if (child?.exitCode === null) {
          void this.terminateChild(child)
        }
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(
          new CursorAcpError(
            'protocol_error',
            `Cursor ACP ${pending.method} failed: ${JSON.stringify(message.error)}`,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.method === 'session/update') {
      const sessionId = message.params?.sessionId
      const update = message.params?.update
      if (typeof sessionId !== 'string' || !update || typeof update !== 'object') {
        return
      }
      const record = update as Record<string, unknown>
      const content = record.content
      if (
        record.sessionUpdate === 'agent_message_chunk' &&
        content &&
        typeof content === 'object' &&
        typeof (content as Record<string, unknown>).text === 'string'
      ) {
        const text = (content as Record<string, unknown>).text as string
        this.messageBuffers.set(sessionId, `${this.messageBuffers.get(sessionId) ?? ''}${text}`)
      }
      return
    }

    if (message.id !== undefined && message.method === 'session/request_permission') {
      this.respond(message.id, { outcome: { outcome: 'cancelled' } })
      return
    }

    if (message.id !== undefined && message.method) {
      this.respondError(message.id, -32601, 'Belay Judge does not expose client tools')
    }
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
  }

  private handleProcessExit(
    error: Error,
    exitedChild: ChildProcessWithoutNullStreams | null = this.child,
  ): void {
    if (exitedChild && this.child !== exitedChild) {
      return
    }
    this.child = null
    this.connected = false
    this.activeSessionId = null
    this.messageBuffers.clear()
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private withStderr(message: string): string {
    const stderr = this.stderrTail.trim()
    return stderr ? `${message}: ${stderr}` : message
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null) {
      return
    }
    if (await this.signalAndWait(child, 'SIGTERM')) {
      return
    }
    await this.signalAndWait(child, 'SIGKILL')
  }

  private signalAndWait(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): Promise<boolean> {
    if (child.exitCode !== null) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (exited: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('close', onExit)
        child.off('error', onExit)
        resolve(exited)
      }
      const onExit = () => finish(true)
      const timer = setTimeout(() => finish(child.exitCode !== null), TERMINATE_GRACE_MS)
      child.once('close', onExit)
      child.once('error', onExit)
      try {
        if (!child.kill(signal)) {
          finish(child.exitCode !== null)
        }
      } catch {
        finish(child.exitCode !== null)
      }
    })
  }
}
