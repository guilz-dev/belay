import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  checkJudgeModelPresence,
  discoverJudgeModels,
  type JudgeModelDiscoveryDeps,
  modelPresenceFromDiscovery,
  parseJsonModelIds,
  parseLineModelIds,
} from '../../core/judge-model-discovery.js'

describe('judge-model-discovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('modelPresenceFromDiscovery', () => {
    it('returns unverified when modelIds is empty', () => {
      expect(
        modelPresenceFromDiscovery({ source: 'cursor-agent', modelIds: [] }, 'composer-2.5'),
      ).toEqual({ status: 'unverified', source: 'cursor-agent' })
    })

    it('returns found for exact match', () => {
      expect(
        modelPresenceFromDiscovery(
          { source: 'cursor-agent', modelIds: ['composer-2.5', 'gpt-5'] },
          'composer-2.5',
        ),
      ).toEqual({ status: 'found', source: 'cursor-agent' })
    })

    it('returns found for ollama tag prefix match', () => {
      expect(
        modelPresenceFromDiscovery({ source: 'ollama-tags', modelIds: ['gemma4:e2b'] }, 'gemma4'),
      ).toEqual({ status: 'found', source: 'ollama-tags' })
    })

    it('returns missing when model is absent', () => {
      expect(
        modelPresenceFromDiscovery(
          { source: 'codex-cli', modelIds: ['gpt-5.3-codex-high'] },
          'composer-2.5',
        ),
      ).toEqual({ status: 'missing', source: 'codex-cli' })
    })
  })

  describe('parse helpers', () => {
    it('parseJsonModelIds reads array entries', () => {
      expect(parseJsonModelIds('[{"id":"composer-2.5"},{"name":"gpt-5"}]')).toEqual([
        'composer-2.5',
        'gpt-5',
      ])
    })

    it('parseLineModelIds falls back to lines', () => {
      expect(parseLineModelIds('composer-2.5\ngpt-5\n')).toEqual(['composer-2.5', 'gpt-5'])
    })
  })

  describe('discoverJudgeModels with deps', () => {
    const cursorDeps: JudgeModelDiscoveryDeps = {
      allowCliDiscovery: true,
      runCommand: async (command, args) => {
        if (command === 'cursor-agent' && args[0] === '--list-models') {
          return JSON.stringify([{ id: 'composer-2.5' }])
        }
        throw new Error(`unexpected command: ${command}`)
      },
    }

    it('discovers cursor models via injected runCommand', async () => {
      const result = await discoverJudgeModels(
        { providerId: 'cursor', model: 'composer-2.5', endpoint: null },
        cursorDeps,
      )
      expect(result).toEqual({ source: 'cursor-agent', modelIds: ['composer-2.5'] })
    })

    it('checkJudgeModelPresence reports found for cursor', async () => {
      const result = await checkJudgeModelPresence(
        { providerId: 'cursor', model: 'composer-2.5', endpoint: null },
        cursorDeps,
      )
      expect(result.status).toBe('found')
    })

    it('discovers codex models from debug models output', async () => {
      const deps: JudgeModelDiscoveryDeps = {
        allowCliDiscovery: true,
        runCommand: async (command) => {
          if (command === 'codex') {
            return JSON.stringify([{ id: 'gpt-5.3-codex-high' }])
          }
          throw new Error('unexpected')
        },
      }
      const result = await discoverJudgeModels(
        { providerId: 'codex', model: 'gpt-5.3-codex-high', endpoint: null },
        deps,
      )
      expect(result.modelIds).toContain('gpt-5.3-codex-high')
    })

    it('discovers ollama models via injected fetch', async () => {
      const deps: JudgeModelDiscoveryDeps = {
        fetch: async () =>
          new Response(JSON.stringify({ models: [{ name: 'gemma4:e2b' }] }), { status: 200 }),
      }
      const result = await discoverJudgeModels(
        {
          providerId: 'ollama',
          model: 'gemma4:e2b',
          endpoint: 'http://127.0.0.1:11434',
        },
        deps,
      )
      expect(result).toEqual({ source: 'ollama-tags', modelIds: ['gemma4:e2b'] })
    })

    it('discovers claude models via injected fetch and api key', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
      const deps: JudgeModelDiscoveryDeps = {
        allowCliDiscovery: true,
        fetch: async (url) => {
          if (String(url).includes('/v1/models')) {
            return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }] }), {
              status: 200,
            })
          }
          return new Response('', { status: 404 })
        },
      }
      const result = await discoverJudgeModels(
        { providerId: 'claude', model: 'claude-sonnet-4-6', endpoint: null },
        deps,
      )
      expect(result.modelIds).toContain('claude-sonnet-4-6')
    })

    it('returns unverified when CLI discovery is disabled', async () => {
      const deps: JudgeModelDiscoveryDeps = {
        allowCliDiscovery: false,
        runCommand: async () => {
          throw new Error('should not run')
        },
      }
      const result = await checkJudgeModelPresence(
        { providerId: 'cursor', model: 'composer-2.5', endpoint: null },
        deps,
      )
      expect(result.status).toBe('unverified')
    })

    it('returns unverified when CLI command fails', async () => {
      const deps: JudgeModelDiscoveryDeps = {
        allowCliDiscovery: true,
        runCommand: async () => {
          throw new Error('cli missing')
        },
      }
      const result = await checkJudgeModelPresence(
        { providerId: 'cursor', model: 'composer-2.5', endpoint: null },
        deps,
      )
      expect(result.status).toBe('unverified')
    })
  })

  describe.skipIf(!process.env.BELAY_LIVE_CLI_DISCOVERY)('live CLI discovery (opt-in)', () => {
    it('probes host cursor-agent when enabled', async () => {
      const result = await discoverJudgeModels({
        providerId: 'cursor',
        model: 'composer-2.5',
        endpoint: null,
      })
      expect(result.source).toBe('cursor-agent')
      expect(Array.isArray(result.modelIds)).toBe(true)
    })
  })
})
