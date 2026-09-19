import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  manifestInferProject,
  manifestListProject,
  manifestRevokeProject,
  manifestTrustProject,
  manifestValidateProject,
} from '../../commands/effect-manifest.js'
import { parseEffectManifestV1 } from '../../core/effect-manifest/codec.js'
import { manifestFilePath } from '../../core/effect-manifest/paths.js'

describe('manifest CLI', () => {
  it('infers, lists, validates, trusts, and revokes a candidate rule', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cli-'))
    const binDir = path.join(repoRoot, 'bin')
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

    const revoked = await manifestRevokeProject({
      targetDir: repoRoot,
      actionCwd: binDir,
      commandText: './demo-tool status',
      ruleId,
    })
    expect(revoked.ok).toBe(true)
  })
})
