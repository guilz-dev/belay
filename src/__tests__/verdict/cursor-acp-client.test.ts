import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  CursorAcpJudgeRunner,
  type CursorAcpSpawn,
  resolveCursorAcpModelId,
} from '../../core/verdict/cursor-acp-client.js'
import { buildCliInvocation } from '../../core/verdict/judge-cli.js'
import { DEFAULT_JUDGE_SESSION_CONFIG } from '../../core/verdict/judge-runtime-config.js'
import { JudgeSessionBroker } from '../../core/verdict/judge-session-broker.js'

const SAFE_JSON = JSON.stringify({
  local_recoverable: true,
  destroys_history_or_secrets: false,
  reason: 'safe',
})

interface FakeAcp {
  child: ChildProcessWithoutNullStreams
  messages: Array<Record<string, unknown>>
  sessionNewCount: () => number
  permissionResponse: () => Record<string, unknown> | null
  killed: () => boolean
  signals: () => NodeJS.Signals[]
}

function createFakeAcp(
  options: { hangPrompt?: boolean; requestPermission?: boolean; ignoreTerminate?: boolean } = {},
): FakeAcp {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const messages: Array<Record<string, unknown>> = []
  let inputBuffer = ''
  let sessionCount = 0
  let killed = false
  const signals: NodeJS.Signals[] = []
  let permissionResponse: Record<string, unknown> | null = null

  const send = (message: Record<string, unknown>) => {
    stdout.write(`${JSON.stringify(message)}\n`)
  }
  const completePrompt = (id: unknown, sessionId: string) => {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: SAFE_JSON },
        },
      },
    })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
  }

  stdin.on('data', (chunk) => {
    inputBuffer += String(chunk)
    const lines = inputBuffer.split('\n')
    inputBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as Record<string, unknown>
      messages.push(message)
      const method = message.method
      if (!method && message.id === 900) {
        permissionResponse = message.result as Record<string, unknown>
        const prompt = [...messages].reverse().find((entry) => entry.method === 'session/prompt')
        const params = prompt?.params as { sessionId?: string } | undefined
        completePrompt(prompt?.id, params?.sessionId ?? 'session-1')
        continue
      }
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
      } else if (method === 'authenticate') {
        send({ jsonrpc: '2.0', id: message.id, result: {} })
      } else if (method === 'session/new') {
        sessionCount += 1
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            sessionId: `session-${sessionCount}`,
            models: {
              currentModelId: 'composer-2.5[fast=true]',
              availableModels: [{ modelId: 'composer-2.5[fast=true]' }],
            },
          },
        })
      } else if (method === 'session/set_config_option' || method === 'session/close') {
        send({ jsonrpc: '2.0', id: message.id, result: {} })
      } else if (method === 'session/prompt' && !options.hangPrompt) {
        const params = message.params as { sessionId?: string }
        if (options.requestPermission) {
          send({
            jsonrpc: '2.0',
            id: 900,
            method: 'session/request_permission',
            params: { sessionId: params.sessionId, options: [] },
          })
        } else {
          completePrompt(message.id, params.sessionId ?? 'session-1')
        }
      }
    }
  })

  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      killed = true
      signals.push(signal)
      if (signal !== 'SIGTERM' || !options.ignoreTerminate) {
        ;(child as unknown as { exitCode: number | null }).exitCode = signal === 'SIGKILL' ? 137 : 0
        queueMicrotask(() => emitter.emit('close', child.exitCode))
      }
      return true
    },
  }) as unknown as ChildProcessWithoutNullStreams

  return {
    child,
    messages,
    sessionNewCount: () => sessionCount,
    permissionResponse: () => permissionResponse,
    killed: () => killed,
    signals: () => signals,
  }
}

describe('cursor-acp-client', () => {
  it('reuses a persistent ACP conversation within broker limits and rotates afterward', async () => {
    const fake = createFakeAcp()
    let spawnCount = 0
    const spawnProcess: CursorAcpSpawn = () => {
      spawnCount += 1
      return fake.child
    }
    const runner = new CursorAcpJudgeRunner({
      cwd: '/tmp/belay-judge-test',
      connectTimeoutMs: 100,
      spawnProcess,
    })
    const broker = new JudgeSessionBroker({
      config: { ...DEFAULT_JUDGE_SESSION_CONFIG, enabled: true, maxTurns: 2 },
      runCommand: runner.run,
      extractResumeId: () => runner.sessionId,
    })
    const keyParts = {
      providerId: 'cursor' as const,
      model: 'composer-2.5',
      repoRoot: '/repo/a',
      judgeMode: 'audit',
      cliVersion: '2026.07',
    }
    const invocation = buildCliInvocation('cursor', 'classify this', 'composer-2.5')

    const first = await broker.evaluate({ keyParts, invocation, promptBytes: 10 }, 100)
    const second = await broker.evaluate({ keyParts, invocation, promptBytes: 10 }, 100)
    const third = await broker.evaluate({ keyParts, invocation, promptBytes: 10 }, 100)

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(third.reused).toBe(false)
    expect(first.raw).toBe(SAFE_JSON)
    expect(spawnCount).toBe(1)
    expect(fake.sessionNewCount()).toBe(2)

    const initialize = fake.messages.find((message) => message.method === 'initialize')
    expect(initialize?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    })
    const modelUpdates = fake.messages.filter((message) => {
      const params = message.params as { configId?: string } | undefined
      return message.method === 'session/set_config_option' && params?.configId === 'model'
    })
    expect(modelUpdates[0]?.params).toMatchObject({ value: 'composer-2.5[fast=true]' })
    await runner.stop()
  })

  it('denies ACP permission requests', async () => {
    const fake = createFakeAcp({ requestPermission: true })
    const runner = new CursorAcpJudgeRunner({
      cwd: '/tmp/belay-judge-test',
      connectTimeoutMs: 100,
      spawnProcess: () => fake.child,
    })

    await expect(
      runner.run(buildCliInvocation('cursor', 'classify', 'composer-2.5'), 100),
    ).resolves.toBe(SAFE_JSON)
    expect(fake.permissionResponse()).toEqual({ outcome: { outcome: 'cancelled' } })
    await runner.stop()
  })

  it('kills the ACP process when evaluation times out', async () => {
    const fake = createFakeAcp({ hangPrompt: true, ignoreTerminate: true })
    const runner = new CursorAcpJudgeRunner({
      cwd: '/tmp/belay-judge-test',
      connectTimeoutMs: 100,
      spawnProcess: () => fake.child,
    })

    await expect(
      runner.run(buildCliInvocation('cursor', 'classify', 'composer-2.5'), 5),
    ).rejects.toThrow('timed out')
    expect(fake.killed()).toBe(true)
    expect(fake.signals()).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('resolves a parameterized ACP model id', () => {
    expect(
      resolveCursorAcpModelId('composer-2.5', {
        sessionId: 'session-1',
        models: {
          availableModels: [{ modelId: 'composer-2.5[fast=true]' }],
        },
      }),
    ).toBe('composer-2.5[fast=true]')
  })
})
