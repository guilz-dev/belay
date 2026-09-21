import { describe, expect, it } from 'vitest'

import { mergeConfig } from '../../core/config.js'
import { inferManifestContractWithLlm } from '../../core/effect-manifest/llm-infer.js'

const cliConfig = mergeConfig({
  judge: {
    provider: 'openai-compatible',
    providerId: 'cursor',
    model: 'configured-model',
    endpoint: null,
    timeoutMs: 1000,
  },
})

const httpConfig = mergeConfig({
  judge: {
    provider: 'ollama',
    providerId: 'ollama',
    model: 'configured-model',
    endpoint: 'http://127.0.0.1:11434',
    timeoutMs: 1000,
  },
})

function ollamaResponse(contract: unknown): Response {
  return new Response(JSON.stringify({ response: JSON.stringify(contract) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('LLM-assisted effect manifest inference', () => {
  it('rejects tool-capable CLI transports instead of launching an agent', async () => {
    let invoked = false
    const result = await inferManifestContractWithLlm(
      { commandBasename: 'tool', canonicalPath: '/usr/bin/tool', argv: ['status'] },
      '/repo',
      cliConfig,
      {
        runCli: async () => {
          invoked = true
          return JSON.stringify({ processOperation: 'inspect', effects: [] })
        },
      } as unknown as Parameters<typeof inferManifestContractWithLlm>[3],
    )
    expect(result).toEqual({
      ok: false,
      error: 'configured_provider_text_only_transport_required',
    })
    expect(invoked).toBe(false)
  })

  it('rejects authority fields outside the closed effect-contract schema', async () => {
    const result = await inferManifestContractWithLlm(
      { commandBasename: 'tool', canonicalPath: '/usr/bin/tool', argv: ['status'] },
      '/repo',
      httpConfig,
      {
        fetchImpl: async () =>
          ollamaResponse({ processOperation: 'inspect', effects: [], assertion: 'trusted' }),
      },
    )
    expect(result).toEqual({ ok: false, error: 'llm_output_schema_invalid' })
  })

  it('scrubs bounded provider input before the explicit request', async () => {
    const prompts: string[] = []
    const runCli = async (_providerId: string, prompt: string) => {
      prompts.push(prompt)
      return JSON.stringify({
        processOperation: 'inspect',
        effects: [{ tag: 'indeterminate', action: 'indeterminate', resource: { kind: 'unknown' } }],
      })
    }
    const result = await inferManifestContractWithLlm(
      {
        commandBasename: 'tool',
        canonicalPath: '/repo/.env',
        argv: ['token=super-secret-token-value'],
      },
      '/repo',
      httpConfig,
      {
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { prompt: string }
          return ollamaResponse(await runCli('ollama', body.prompt))
        },
      },
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.ok).toBe(true)
    const prompt = prompts[0]
    expect(prompt).not.toContain('super-secret-token-value')
    expect(prompt).not.toContain('/repo/.env')
  })
})
