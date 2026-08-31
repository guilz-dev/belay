import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { approvedApprovalsPath, loadConfigFile, pendingApprovalsPath } from '../config-io.js'
import { findApprovalRepoRoots } from '../core/approval-repo-lookup.js'
import { mergeConfig } from '../core/config.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

async function createTempRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-approval-lookup-'))
  tempDirs.push(repoRoot)
  await initProject({ targetDir: repoRoot })
  const config = mergeConfig({
    ...(await loadConfigFile(repoRoot)),
    mode: 'enforce',
  })
  await writeFile(
    path.join(repoRoot, '.cursor', 'belay.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return repoRoot
}

describe('findApprovalRepoRoots', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('finds a unique repo root containing the approval id', async () => {
    const repoRoot = await createTempRepo()
    const config = await loadConfigFile(repoRoot)
    const pendingPath = pendingApprovalsPath(repoRoot, config)
    const approvalId = 'belay_lookup_test'
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          version: 1,
          approvals: [
            {
              approvalId,
              kind: 'shell',
              input: 'git push origin main',
              inputKind: 'shell',
              repoRoot,
              cwd: repoRoot,
              fingerprint: 'abc',
              createdAt: '2026-08-31T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const lookup = await findApprovalRepoRoots({
      approvalId,
      candidateRepoRoots: [repoRoot],
      adapter: 'cursor',
    })
    expect(lookup).toEqual({ status: 'found', repoRoot: path.resolve(repoRoot) })
  })

  it('reports ambiguous matches across multiple repos', async () => {
    const repoA = await createTempRepo()
    const repoB = await createTempRepo()
    const approvalId = 'belay_lookup_ambiguous'
    for (const repoRoot of [repoA, repoB]) {
      const config = await loadConfigFile(repoRoot)
      await writeFile(
        pendingApprovalsPath(repoRoot, config),
        `${JSON.stringify(
          {
            version: 1,
            approvals: [
              {
                approvalId,
                kind: 'shell',
                input: 'git push origin main',
                inputKind: 'shell',
                repoRoot,
                cwd: repoRoot,
                fingerprint: 'abc',
                createdAt: '2026-08-31T00:00:00.000Z',
              },
            ],
          },
          null,
          2,
        )}\n`,
      )
    }

    const lookup = await findApprovalRepoRoots({
      approvalId,
      candidateRepoRoots: [repoA, repoB],
      adapter: 'cursor',
    })
    expect(lookup.status).toBe('ambiguous')
    if (lookup.status === 'ambiguous') {
      expect(lookup.repoRoots).toHaveLength(2)
    }
  })

  it('checks approved state files as well as pending', async () => {
    const repoRoot = await createTempRepo()
    const config = await loadConfigFile(repoRoot)
    const approvalId = 'belay_lookup_approved'
    await writeFile(
      approvedApprovalsPath(repoRoot, config),
      `${JSON.stringify(
        {
          version: 1,
          approvals: [
            {
              approvalId,
              kind: 'shell',
              input: 'git push origin main',
              inputKind: 'shell',
              repoRoot,
              cwd: repoRoot,
              fingerprint: 'abc',
              createdAt: '2026-08-31T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )

    const lookup = await findApprovalRepoRoots({
      approvalId,
      candidateRepoRoots: [repoRoot],
      adapter: 'cursor',
    })
    expect(lookup).toEqual({ status: 'found', repoRoot: path.resolve(repoRoot) })
  })
})
