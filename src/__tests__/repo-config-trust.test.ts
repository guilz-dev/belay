import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { defaultControlPlaneDir } from '../core/config.js'
import { canonicalPath } from '../core/path-utils.js'
import {
  inspectRepoConfigTrust,
  repoConfigFingerprint,
  repoConfigTrustPath,
  trustRepoConfig,
} from '../core/repo-config-trust.js'

const tempDirs: string[] = []
const originalHome = process.env.HOME
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

afterEach(async () => {
  process.env.HOME = originalHome
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('repo config trust', () => {
  it('writes a canonical identity record with 0600 permissions', async () => {
    const home = await createTempDir('belay-trust-home-')
    const repoRoot = await createTempDir('belay-trust-repo-')
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = path.join(home, '.config')
    const rawConfig = {
      mode: 'audit',
      policy: { unknownLocalEffect: 'deny' },
      controlPlane: { configDir: path.join(repoRoot, 'custom-cp') },
    }

    const record = await trustRepoConfig(repoRoot, 'cursor', rawConfig)
    const recordPath = repoConfigTrustPath(repoRoot, 'cursor')
    const saved = JSON.parse(await readFile(recordPath, 'utf8')) as typeof record
    const recordMode = (await stat(recordPath)).mode & 0o777
    const parentMode = (await stat(path.dirname(recordPath))).mode & 0o777

    expect(record).toEqual(saved)
    expect(record.schemaVersion).toBe(1)
    expect(record.repoRoot).toBe(canonicalPath(repoRoot))
    expect(record.adapter).toBe('cursor')
    expect(record.repoConfigFingerprint).toBe(repoConfigFingerprint(rawConfig))
    expect(record.trustedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(recordMode).toBe(0o600)
    expect(parentMode).toBe(0o700)
  })

  it('accepts the unchanged raw repo config', async () => {
    const home = await createTempDir('belay-trust-home-')
    const repoRoot = await createTempDir('belay-trust-repo-')
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = path.join(home, '.config')
    const rawConfig = { mode: 'enforce', gates: { shell: true } }

    await trustRepoConfig(repoRoot, 'cursor', rawConfig)
    const status = await inspectRepoConfigTrust(repoRoot, 'cursor', rawConfig)

    expect(status.trusted).toBe(true)
    if (status.trusted) {
      expect(status.fingerprint).toBe(repoConfigFingerprint(rawConfig))
      expect(status.recordPath).toBe(repoConfigTrustPath(repoRoot, 'cursor'))
    }
  })

  it('rejects a manually edited repo config', async () => {
    const home = await createTempDir('belay-trust-home-')
    const repoRoot = await createTempDir('belay-trust-repo-')
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = path.join(home, '.config')
    const trustedConfig = { mode: 'enforce', policy: { unknownLocalEffect: 'allow_flagged' } }
    const editedConfig = { mode: 'audit', policy: { unknownLocalEffect: 'deny' } }

    await trustRepoConfig(repoRoot, 'cursor', trustedConfig)
    const status = await inspectRepoConfigTrust(repoRoot, 'cursor', editedConfig)

    expect(status).toMatchObject({
      trusted: false,
      reason: 'fingerprint_mismatch',
    })
  })

  it('rejects malformed and identity-rebound records', async () => {
    const home = await createTempDir('belay-trust-home-')
    const repoRoot = await createTempDir('belay-trust-repo-')
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = path.join(home, '.config')
    const rawConfig = { mode: 'enforce' }

    const record = await trustRepoConfig(repoRoot, 'cursor', rawConfig)
    const recordPath = repoConfigTrustPath(repoRoot, 'cursor')

    await writeFile(recordPath, '{ not-json', 'utf8')
    await expect(inspectRepoConfigTrust(repoRoot, 'cursor', rawConfig)).resolves.toMatchObject({
      trusted: false,
      reason: 'malformed',
    })

    await writeFile(
      recordPath,
      `${JSON.stringify({ ...record, repoRoot: path.join(repoRoot, '..', 'other') })}\n`,
      'utf8',
    )
    await expect(inspectRepoConfigTrust(repoRoot, 'cursor', rawConfig)).resolves.toMatchObject({
      trusted: false,
      reason: 'identity_mismatch',
    })

    await writeFile(recordPath, `${JSON.stringify({ ...record, extraField: true })}\n`, 'utf8')
    await expect(inspectRepoConfigTrust(repoRoot, 'cursor', rawConfig)).resolves.toMatchObject({
      trusted: false,
      reason: 'malformed',
    })
  })

  it('uses defaultControlPlaneDir even when repo config names another configDir', async () => {
    const home = await createTempDir('belay-trust-home-')
    const repoRoot = await createTempDir('belay-trust-repo-')
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = path.join(home, '.config')
    const rawConfig = {
      controlPlane: {
        enabled: true,
        configDir: path.join(repoRoot, '.repo-owned-control-plane'),
      },
    }

    const record = await trustRepoConfig(repoRoot, 'cursor', rawConfig)
    const defaultCp = defaultControlPlaneDir()

    expect(record.repoRoot).toBe(canonicalPath(repoRoot))
    expect(repoConfigTrustPath(repoRoot, 'cursor')).toContain(
      path.join(defaultCp, 'config-trust') + path.sep,
    )
    expect(repoConfigTrustPath(repoRoot, 'cursor')).not.toContain(
      path.join(repoRoot, '.repo-owned-control-plane'),
    )
  })

  it.runIf(process.platform !== 'win32')(
    'treats symlink-equivalent repo roots as one identity',
    async () => {
      const home = await createTempDir('belay-trust-home-')
      const repoRoot = await createTempDir('belay-trust-repo-')
      const linkParent = await createTempDir('belay-trust-link-')
      const linkedRoot = path.join(linkParent, 'repo-link')
      process.env.HOME = home
      process.env.XDG_CONFIG_HOME = path.join(home, '.config')
      await symlink(repoRoot, linkedRoot, 'dir')
      const rawConfig = { mode: 'enforce', tokenPrefix: '/belay-approve' }

      await trustRepoConfig(linkedRoot, 'cursor', rawConfig)
      const status = await inspectRepoConfigTrust(repoRoot, 'cursor', rawConfig)

      expect(repoConfigTrustPath(repoRoot, 'cursor')).toBe(
        repoConfigTrustPath(linkedRoot, 'cursor'),
      )
      expect(status).toMatchObject({ trusted: true })
    },
  )
})
