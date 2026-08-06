import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildJudgeCredentialModeSelectOptions,
  buildJudgeTransportSelectOptions,
  JUDGE_CREDENTIAL_MODE_PROMPT,
  JUDGE_CREDENTIAL_STORE_KEY_PROMPT,
  JUDGE_HTTP_ENDPOINT_PROMPT,
  JUDGE_TRANSPORT_MODE_PROMPT,
  runBelayConfigJudgeOnlyInteractive,
} from '../commands/config.js'
import { loadConfigFile, repoLocalStateDirFor } from '../config-io.js'
import { belayStateDir } from '../core/config.js'
import { readJudgeCredentialStore } from '../core/credential-store.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []

async function createTempRepo(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'belay-config-prompts-'))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('config wizard credential prompts', () => {
  it('uses a select prompt title instead of the legacy confirm wording', () => {
    expect(JUDGE_CREDENTIAL_MODE_PROMPT).toBe('Judge API key source')
    expect(JUDGE_CREDENTIAL_MODE_PROMPT).not.toContain('project env')
  })

  it('defaults to project and documents env vars per provider', () => {
    const codex = buildJudgeCredentialModeSelectOptions('codex')
    expect(codex.defaultValue).toBe('project')
    expect(codex.choices.map((choice) => choice.value)).toEqual(['project', 'apiKey'])
    expect(codex.choices[0]?.hint).toContain('BELAY_JUDGE_API_KEY')
    expect(codex.choices[0]?.hint).toContain('OPENAI_API_KEY')
    expect(codex.choices[0]?.hint).toContain('does not read .env files')
    expect(codex.choices[1]?.hint).toContain('credentials.json')
  })

  it('mentions host CLI login for cloud providers', () => {
    const claude = buildJudgeCredentialModeSelectOptions('claude')
    expect(claude.choices[0]?.hint).toContain('ANTHROPIC_API_KEY')
    expect(claude.choices[0]?.hint).toContain('host CLI login')
  })

  it('uses a store-key prompt that points to --key-stdin', () => {
    expect(JUDGE_CREDENTIAL_STORE_KEY_PROMPT).toContain('--key-stdin')
  })

  it('defaults transport to host CLI with provider-specific labels', () => {
    const cursor = buildJudgeTransportSelectOptions('cursor')
    expect(JUDGE_TRANSPORT_MODE_PROMPT).toBe('How should Belay reach the judge?')
    expect(cursor.defaultValue).toBe('cli')
    expect(cursor.choices[0]?.label).toContain('Cursor CLI')
    expect(cursor.choices[0]?.hint).toContain('no URL needed')
    expect(cursor.choices[1]?.label).toContain('Custom HTTP API endpoint')
    expect(JUDGE_HTTP_ENDPOINT_PROMPT).toBe('Judge HTTP API URL:')
    expect(JUDGE_HTTP_ENDPOINT_PROMPT).not.toContain('optional')
  })

  it('stores apiKey when wizard prompts provide a key', async () => {
    const dir = await createTempRepo()
    await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })

    await runBelayConfigJudgeOnlyInteractive({
      targetDir: dir,
      prompts: ['codex', 'apiKey', 'cli', 'sk-wizard-key'],
    })

    const config = await loadConfigFile(dir)
    expect(config.judge.providerId).toBe('codex')
    expect(config.judge.credential?.mode).toBe('apiKey')
    expect(config.judge.credential?.ref).toBe('store:judge')
    const stateDir = belayStateDir(config, repoLocalStateDirFor(dir, config))
    expect(await readJudgeCredentialStore(stateDir)).toBe('sk-wizard-key')
  })

  it('rejects empty apiKey paste and retries until non-empty', async () => {
    const dir = await createTempRepo()
    await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })

    await runBelayConfigJudgeOnlyInteractive({
      targetDir: dir,
      prompts: ['codex', 'apiKey', 'cli', '', 'sk-wizard-key'],
    })

    const config = await loadConfigFile(dir)
    expect(config.judge.credential?.mode).toBe('apiKey')
    const stateDir = belayStateDir(config, repoLocalStateDirFor(dir, config))
    expect(await readJudgeCredentialStore(stateDir)).toBe('sk-wizard-key')
  })

  it('keeps project mode without asking for a stored key', async () => {
    const dir = await createTempRepo()
    await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })

    await runBelayConfigJudgeOnlyInteractive({
      targetDir: dir,
      prompts: ['codex', 'project', 'cli'],
    })

    const config = await loadConfigFile(dir)
    expect(config.judge.credential?.mode).toBe('project')
    expect(config.judge.endpoint).toBeNull()
    const stateDir = belayStateDir(config, repoLocalStateDirFor(dir, config))
    expect(await readJudgeCredentialStore(stateDir)).toBeNull()
  })

  it('records HTTP endpoint and cloud consent when custom API is chosen', async () => {
    const dir = await createTempRepo()
    await initProject({ targetDir: dir, adapter: 'cursor', withSkill: false })

    await runBelayConfigJudgeOnlyInteractive({
      targetDir: dir,
      prompts: ['codex', 'project', 'http', 'https://api.openai.com/v1', 'y'],
    })

    const config = await loadConfigFile(dir)
    expect(config.judge.endpoint).toBe('https://api.openai.com/v1')
    expect(config.judge.cloudConsent?.accepted).toBe(true)
  })
})
