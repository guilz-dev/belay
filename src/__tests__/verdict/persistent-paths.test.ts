import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isOutsideRepoSecretCredentialPath,
  isPersistentAgentPath,
  OUTSIDE_REPO_SECRET_CREDENTIAL_MARKERS,
  PERSISTENT_AGENT_PATH_MARKERS,
} from '../../core/verdict/persistent-paths.js'

describe('persistent agent paths (M3 catalog)', () => {
  it('exports markers aligned with tier0-retention-ledger', () => {
    expect(PERSISTENT_AGENT_PATH_MARKERS).toContain('.ssh/authorized_keys')
    expect(PERSISTENT_AGENT_PATH_MARKERS).toContain('.config/')
    expect(OUTSIDE_REPO_SECRET_CREDENTIAL_MARKERS).toContain('.env')
    expect(OUTSIDE_REPO_SECRET_CREDENTIAL_MARKERS).toContain('*.pem')
    expect(OUTSIDE_REPO_SECRET_CREDENTIAL_MARKERS).toContain('.ssh/id_*')
    expect(OUTSIDE_REPO_SECRET_CREDENTIAL_MARKERS).toContain('.npmrc')
  })

  it('detects persistent agent startup paths', () => {
    const home = process.env.HOME ?? '/home/user'
    expect(isPersistentAgentPath(path.join(home, '.zshrc'))).toBe(true)
    expect(isPersistentAgentPath(path.join(home, '.ssh/authorized_keys'))).toBe(true)
    expect(isPersistentAgentPath(path.join(home, '.config/app/settings.json'))).toBe(true)
    expect(isPersistentAgentPath('/tmp/benign.txt')).toBe(false)
    expect(isPersistentAgentPath(path.join(home, '.cursor/plans/foo.plan.md'))).toBe(false)
  })

  it('detects outside-repo secret and credential paths', () => {
    const home = process.env.HOME ?? '/home/user'
    expect(isOutsideRepoSecretCredentialPath(path.join(home, '.env'))).toBe(true)
    expect(isOutsideRepoSecretCredentialPath(path.join(home, '.env.local'))).toBe(true)
    expect(isOutsideRepoSecretCredentialPath(path.join(home, 'secret.pem'))).toBe(true)
    expect(isOutsideRepoSecretCredentialPath(path.join(home, '.ssh/id_ed25519'))).toBe(true)
    expect(isOutsideRepoSecretCredentialPath(path.join(home, '.npmrc'))).toBe(true)
    expect(isOutsideRepoSecretCredentialPath(path.join(home, '.kube/config'))).toBe(true)
    expect(isOutsideRepoSecretCredentialPath('/tmp/benign.txt')).toBe(false)
    expect(isOutsideRepoSecretCredentialPath(path.join(home, '.cursor/plans/foo.plan.md'))).toBe(
      false,
    )
  })
})
