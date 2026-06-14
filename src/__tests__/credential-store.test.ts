import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3, rejectTeamLayerJudgeSecrets } from '../core/config.js'
import { resolveLayeredConfig } from '../core/config-layers.js'
import {
  credentialStorePath,
  readJudgeCredentialStore,
  writeJudgeCredentialStore,
} from '../core/credential-store.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('credential store', () => {
  it('writes credentials.json with mode 0600', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'belay-cred-'))
    tempDirs.push(stateDir)
    await writeJudgeCredentialStore(stateDir, 'sk-test-key')
    const filePath = credentialStorePath(stateDir)
    const mode = (await stat(filePath)).mode & 0o777
    expect(mode).toBe(0o600)
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.judge).toBe('sk-test-key')
    expect(await readJudgeCredentialStore(stateDir)).toBe('sk-test-key')
  })

  it('rejects apiKey credential mode in team config layer', () => {
    expect(() =>
      rejectTeamLayerJudgeSecrets(
        {
          credential: { mode: 'apiKey', ref: 'store:judge' },
        },
        'team',
      ),
    ).toThrow(/team config cannot set judge.credential.mode to apiKey/)
  })

  it('allows project credential mode in team config layer', () => {
    expect(() =>
      rejectTeamLayerJudgeSecrets(
        {
          credential: { mode: 'project' },
        },
        'team',
      ),
    ).not.toThrow()
  })

  it('team layer merge rejects apiKey judge secrets', () => {
    expect(() =>
      resolveLayeredConfig({
        repoConfig: {},
        adapterDefaults: DEFAULT_CONFIG_V3,
        teamConfig: {
          config: {
            judge: {
              credential: { mode: 'apiKey', ref: 'env:OPENAI_API_KEY' },
            },
          },
        },
        teamConfigPath: '/home/user/.config/agent-belay/team.config.json',
      }),
    ).toThrow(/team config cannot set judge.credential.mode to apiKey/)
  })
})
