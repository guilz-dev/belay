import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { judgeRequestCloudConsent } from '../../commands/judge.js'
import { loadApprovalState } from '../../config-io.js'
import { JUDGE_CLOUD_CONSENT_REASON } from '../../core/capability/reasons.js'
import { initProject } from '../../installer.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('judge cloud consent capability', () => {
  it('creates pending capability approval for belay approve', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-judge-consent-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const message = (await judgeRequestCloudConsent({
      targetDir: repoRoot,
      providerId: 'openai',
    })) as string
    expect(message).toContain('belay approve belay_')

    const config = await import('../../config-io.js').then((m) => m.loadConfigFile(repoRoot))
    const pending = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
    expect(
      pending.approvals.some(
        (entry) => entry.reason === JUDGE_CLOUD_CONSENT_REASON && entry.kind === 'capability',
      ),
    ).toBe(true)
  })
})
