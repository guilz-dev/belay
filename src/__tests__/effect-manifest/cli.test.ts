import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  formatManifestTrustResult,
  manifestInferProject,
  manifestListProject,
  manifestRevokeProject,
  manifestShowProject,
  manifestTrustProject,
  manifestValidateProject,
} from '../../commands/effect-manifest.js'
import { configPathFor } from '../../config-io.js'
import { parseEffectManifestV1 } from '../../core/effect-manifest/codec.js'
import { manifestFilePath } from '../../core/effect-manifest/paths.js'

describe('manifest CLI', () => {
  it('infers, lists, validates, trusts, and revokes a candidate rule', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cli-'))
    const binDir = path.join(repoRoot, 'bin')
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cli-trust-'))
    const configPath = configPathFor(repoRoot, 'cursor')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        version: 4,
        controlPlane: { enabled: false, configDir: controlPlaneDir },
        judge: {
          provider: 'openai-compatible',
          providerId: 'cursor',
          model: 'configured-model',
          endpoint: null,
          timeoutMs: 1000,
        },
      }),
    )
    await mkdir(binDir, { recursive: true })
    const toolPath = path.join(binDir, 'demo-tool')
    await writeFile(toolPath, '#!/bin/sh\necho demo\n', { mode: 0o755 })
    await chmod(toolPath, 0o755)

    const inferred = await manifestInferProject({
      targetDir: repoRoot,
      actionCwd: binDir,
      inferArgv: ['./demo-tool', 'status'],
    })
    expect(inferred.ok).toBe(true)
    if (!inferred.ok) {
      throw new Error('infer failed')
    }

    const listed = await manifestListProject({ targetDir: repoRoot })
    expect(listed.manifests).toHaveLength(1)
    expect(listed.manifests[0]?.basename).toBe('demo-tool')

    const validated = await manifestValidateProject({
      targetDir: repoRoot,
      commandText: './demo-tool status',
    })
    expect(validated.ok).toBe(true)

    const manifest = parseEffectManifestV1(
      JSON.parse(await readFile(manifestFilePath(repoRoot, 'demo-tool'), 'utf8')),
    )
    const ruleId = manifest?.rules[0]?.id
    expect(ruleId).toBeTruthy()
    if (!manifest?.rules[0]) {
      throw new Error('expected manifest rule')
    }

    const blocked = await manifestTrustProject({
      targetDir: repoRoot,
      actionCwd: binDir,
      commandText: './demo-tool status',
      ruleId,
    })
    expect(blocked.ok).toBe(false)

    manifest.rules[0].contract.effects = []
    await writeFile(manifestFilePath(repoRoot, 'demo-tool'), JSON.stringify(manifest, null, 2))

    const trusted = await manifestTrustProject({
      targetDir: repoRoot,
      actionCwd: binDir,
      commandText: './demo-tool status',
      ruleId,
    })
    expect(trusted.ok).toBe(true)
    expect(formatManifestTrustResult(trusted)).toContain('Matcher:')
    expect(formatManifestTrustResult(trusted)).toContain('Effect contract:')

    const shown = await manifestShowProject({
      targetDir: repoRoot,
      commandText: './demo-tool status',
    })
    expect(shown.ok).toBe(true)
    if (!shown.ok) {
      throw new Error('show failed')
    }
    expect(shown.identityStatus).toBe('ok')
    expect(shown.rules[0]?.trust).toBe('trusted')

    await writeFile(toolPath, '#!/bin/sh\necho changed\n', { mode: 0o755 })
    const stale = await manifestShowProject({
      targetDir: repoRoot,
      commandText: './demo-tool status',
    })
    expect(stale.ok).toBe(true)
    if (!stale.ok) {
      throw new Error('show failed')
    }
    expect(stale.identityStatus).toBe('changed')
    expect(stale.rules[0]?.trust).toBe('stale')

    const revoked = await manifestRevokeProject({
      targetDir: repoRoot,
      actionCwd: binDir,
      commandText: './demo-tool status',
      ruleId,
    })
    expect(revoked.ok).toBe(true)
  })

  it('uses an existing provider only for explicit --llm and keeps output untrusted', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cli-llm-'))
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cli-llm-trust-'))
    const binDir = path.join(repoRoot, 'bin')
    const configPath = configPathFor(repoRoot, 'cursor')
    await mkdir(binDir, { recursive: true })
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(path.join(binDir, 'demo-tool'), 'native fixture\n', { mode: 0o755 })
    await writeFile(
      configPath,
      JSON.stringify({
        version: 4,
        controlPlane: { enabled: false, configDir: controlPlaneDir },
        judge: {
          provider: 'ollama',
          providerId: 'ollama',
          model: 'configured-model',
          endpoint: 'http://127.0.0.1:11434',
          timeoutMs: 1000,
        },
      }),
    )
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            response: JSON.stringify({
              processOperation: 'inspect',
              effects: [
                {
                  tag: 'network.connect',
                  action: 'network.connect',
                  resource: {
                    kind: 'network',
                    host: 'api.example.com',
                    protocol: 'https',
                    mode: 'read',
                    payload: 'none',
                  },
                },
              ],
            }),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )

    const offline = await manifestInferProject({
      targetDir: repoRoot,
      actionCwd: binDir,
      inferArgv: ['./demo-tool', 'offline'],
      llmDependencies: { fetchImpl },
    })
    expect(offline.ok).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()

    const assisted = await manifestInferProject({
      targetDir: repoRoot,
      actionCwd: binDir,
      inferArgv: ['./demo-tool', 'status'],
      llm: true,
      llmDependencies: { fetchImpl },
    })
    if (!assisted.ok) {
      throw new Error(assisted.error)
    }
    expect(assisted.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const manifest = parseEffectManifestV1(
      JSON.parse(await readFile(manifestFilePath(repoRoot, 'demo-tool'), 'utf8')),
    )
    const rule = manifest?.rules.find((entry) => entry.id === assisted.ruleId)
    expect(rule?.inference.method).toBe('llm-assisted')
    expect(rule?.contract.effects[0]?.action).toBe('network.connect')

    const shown = await manifestShowProject({ targetDir: repoRoot, commandText: './demo-tool' })
    expect(shown.ok).toBe(true)
    if (shown.ok) {
      expect(shown.rules.every((entry) => entry.trust === 'missing')).toBe(true)
    }
  })
})
