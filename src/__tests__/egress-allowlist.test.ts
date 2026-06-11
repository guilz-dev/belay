import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  addDomainToAllowlist,
  isHostAllowlisted,
  loadEgressAllowlist,
  saveEgressAllowlist,
} from '../core/egress/allowlist.js'

const tempDirs: string[] = []

describe('egress allowlist', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('persists and reloads domain entries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-egress-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'egress-allowlist.json')

    await saveEgressAllowlist(
      filePath,
      addDomainToAllowlist(
        { version: 1, domains: [] },
        {
          host: 'API.Example.COM',
          approvedAt: '2026-01-01T00:00:00.000Z',
          approvalId: 'belay_domain',
        },
      ),
    )

    const loaded = await loadEgressAllowlist(filePath)
    expect(isHostAllowlisted('api.example.com', loaded)).toBe(true)
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { domains: Array<{ host: string }> }
    expect(raw.domains[0]?.host).toBe('api.example.com')
  })
})
