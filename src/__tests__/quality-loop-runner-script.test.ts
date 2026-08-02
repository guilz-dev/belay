import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const runnerPath = path.join(repoRoot, 'scripts', 'quality-loop-runner.sh')
const tempDirs: string[] = []

function runRunner(args: string[]) {
  return spawnSync('bash', [runnerPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

async function createTempArtifact(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-quality-loop-runner-'))
  tempDirs.push(dir)
  const artifactPath = path.join(dir, 'iteration-test.json')
  await writeFile(
    artifactPath,
    JSON.stringify(
      {
        batchId: 'test-batch',
      },
      null,
      2,
    ),
  )
  return artifactPath
}

async function createTempRouting(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-quality-loop-routing-'))
  tempDirs.push(dir)
  const routingPath = path.join(dir, 'workflow-routing.yaml')
  await writeFile(routingPath, contents)
  return routingPath
}

describe('quality-loop-runner script', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('fails when required --from-artifact is missing', () => {
    const result = runRunner([])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--from-artifact is required.')
  })

  it('fails when artifact path does not exist', () => {
    const result = runRunner(['--from-artifact', 'artifacts/quality-loop/missing.json'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Artifact not found:')
  })

  it('fails when belay config path does not exist', async () => {
    const artifactPath = await createTempArtifact()
    const result = runRunner([
      '--from-artifact',
      artifactPath,
      '--belay-config',
      'configs/quality-loop/missing.json',
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Belay config not found:')
  })

  it('fails when target workflow entry is missing in routing file', async () => {
    const artifactPath = await createTempArtifact()
    const routingPath = await createTempRouting(`
version: 1
workflows:
  - name: other-workflow
    safetyTier: sandboxed-write
`)

    const result = runRunner([
      '--from-artifact',
      artifactPath,
      '--routing-file',
      routingPath,
      '--workflow-name',
      'quality-loop-fix',
    ])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Workflow entry not found in routing file')
  })

  it('fails when workflow safetyTier does not match required tier', async () => {
    const artifactPath = await createTempArtifact()
    const routingPath = await createTempRouting(`
version: 1
workflows:
  - name: quality-loop-fix
    safetyTier: safe
`)

    const result = runRunner([
      '--from-artifact',
      artifactPath,
      '--routing-file',
      routingPath,
      '--workflow-name',
      'quality-loop-fix',
      '--required-safety-tier',
      'sandboxed-write',
    ])

    expect(result.status).toBe(4)
    expect(result.stderr).toContain('safetyTier mismatch for quality-loop-fix')
  })
})
