import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { doctorProject } from '../commands/doctor.js'
import { dogfoodProject } from '../commands/dogfood.js'
import { pendingApprovalsPath } from '../config-io.js'
import { initProject } from '../installer.js'

const tempDirs: string[] = []
const originalHome = process.env.HOME
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalSystemRoot = process.env.SystemRoot

afterEach(async () => {
  vi.restoreAllMocks()
  process.env.HOME = originalHome
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  }
  if (originalSystemRoot === undefined) {
    delete process.env.SystemRoot
  } else {
    process.env.SystemRoot = originalSystemRoot
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('doctorProject', () => {
  it('reports a selected project shim whose embedded origin is global', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-origin-mismatch-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    const shellShim = path.join(repoRoot, '.cursor', 'hooks', 'belay-shell-gate.mjs')
    const source = await readFile(shellShim, 'utf8')
    await writeFile(shellShim, source.replace('{"scope":"project"', '{"scope":"global"'))

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some((issue) => issue.includes('origin mismatch') && issue.includes('project')),
    ).toBe(true)
  })

  it('reports a pre-router shim generation for the intended owner', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-router-generation-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    await writeFile(
      path.join(repoRoot, '.cursor', 'hooks', 'belay-shell-gate.mjs'),
      "import { runShellGateHook } from '../belay/runtime/core.mjs'\nawait runShellGateHook()\n",
    )

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some(
        (issue) => issue.includes('router generation mismatch') && issue.includes('upgrade'),
      ),
    ).toBe(true)
  })

  it('reports a pre-router dispatcher generation when integrity pinning is disabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-old-dispatcher-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        controlPlane: { ...config.controlPlane, integrity: 'none' },
      })}\n`,
    )
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'),
      [
        '// deceptive legacy comments: routeCursorHook neutralResponse origin',
        '// export const BELAY_CURSOR_DISPATCHER_GENERATION = "cursor-owner-router-v1";',
        '',
      ].join('\n'),
    )

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some(
        (issue) => issue.includes('router generation mismatch') && issue.includes('dispatcher'),
      ),
    ).toBe(true)
  })

  it('reports a managed Cursor entry that has not migrated to failClosed', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-host-fail-closed-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        controlPlane: { ...config.controlPlane, integrity: 'none' },
      })}\n`,
    )
    const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json')
    const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: { beforeShellExecution: Array<Record<string, unknown>> }
    }
    delete hooks.hooks.beforeShellExecution[0]?.failClosed
    await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`)

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some(
        (issue) => issue.includes('beforeShellExecution') && issue.includes('failClosed: true'),
      ),
    ).toBe(true)
  })

  it('reports an incomplete intended project owner when its dispatcher is missing', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-incomplete-owner-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    await rm(path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'))

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some(
        (issue) =>
          issue.includes('intended project owner is incomplete') && issue.includes('dispatcher'),
      ),
    ).toBe(true)
  })

  it('does not mislabel missing audit or approval state as an incomplete routing owner', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-missing-state-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    await rm(path.join(repoRoot, config.audit.logPath))
    await rm(pendingApprovalsPath(repoRoot, config))

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(report.issues.some((issue) => issue.includes('Missing generated file'))).toBe(true)
    expect(
      report.issues.some(
        (issue) =>
          issue.includes('owner is incomplete') &&
          (issue.includes('audit') || issue.includes('pending-approvals')),
      ),
    ).toBe(false)
  })

  it('reports an old managed global install that cannot yield to the project owner', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-old-global-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-old-global-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    await initProject({ targetDir: repoRoot, scope: 'global' })
    await initProject({ targetDir: repoRoot, scope: 'project' })
    await writeFile(
      path.join(homeDir, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'),
      '// pre-router dispatcher generation\n',
    )

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some((issue) =>
        issue.includes('Global Cursor installation cannot yield to the project owner'),
      ),
    ).toBe(true)
  })

  it('requires the Windows runner when checking a shadowed global install', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-win-global-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-win-global-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    process.env.SystemRoot = 'D:\\Windows'
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await initProject({ targetDir: repoRoot, scope: 'global' })
    await initProject({ targetDir: repoRoot, scope: 'project' })
    await rm(path.join(homeDir, '.cursor', 'hooks', 'belay-runner.ps1'), { force: true })

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some((issue) =>
        issue.includes('Global Cursor installation cannot yield to the project owner'),
      ),
    ).toBe(true)
  })

  it.each([
    'claude',
    'codex',
  ] as const)('uses the actual Windows .cmd runner when diagnosing a healthy %s install', async (adapter) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), `belay-doctor-win-${adapter}-`))
    tempDirs.push(repoRoot)
    process.env.SystemRoot = 'D:\\Windows'
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await initProject({ targetDir: repoRoot, adapter, judgeProviderId: 'ollama' })

    const hooksDir = path.join(repoRoot, `.${adapter}`, 'hooks')
    expect(existsSync(path.join(hooksDir, 'belay-runner.cmd'))).toBe(true)
    expect(existsSync(path.join(hooksDir, 'belay-runner.ps1'))).toBe(false)

    const report = await doctorProject({ targetDir: repoRoot, adapter })

    expect(report.issues).toEqual([])
    expect(report.ok).toBe(true)
    expect(
      report.issues.some(
        (issue) => issue.includes('Missing generated file') && issue.includes('belay-runner'),
      ),
    ).toBe(false)
  })

  it('notes a healthy global install shadowed by the selected project owner', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-shadowed-global-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-shadowed-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    await initProject({ targetDir: repoRoot, scope: 'global' })
    await initProject({ targetDir: repoRoot, scope: 'project' })

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(true)
    expect(
      report.notes.some((note) => note.includes('Healthy global Cursor install is shadowed')),
    ).toBe(true)
    expect(report.warnings.some((warning) => warning.toLowerCase().includes('shadow'))).toBe(false)
  })

  it('diagnoses malformed shadowed global Cursor hooks without throwing', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-shadow-hooks-json-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-shadow-hooks-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    await initProject({ targetDir: repoRoot, scope: 'global' })
    await initProject({ targetDir: repoRoot, scope: 'project' })
    await writeFile(path.join(homeDir, '.cursor', 'hooks.json'), '{ malformed')

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some((issue) =>
        issue.includes('Unable to inspect shadowed global Cursor hooks'),
      ),
    ).toBe(true)
  })

  it('diagnoses unreadable shadowed global Cursor hooks without throwing', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-shadow-hooks-read-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-shadow-hooks-read-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    await initProject({ targetDir: repoRoot, scope: 'global' })
    await initProject({ targetDir: repoRoot, scope: 'project' })
    const globalHooksPath = path.join(homeDir, '.cursor', 'hooks.json')
    await rm(globalHooksPath)
    await mkdir(globalHooksPath)

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some((issue) =>
        issue.includes('Unable to inspect shadowed global Cursor hooks'),
      ),
    ).toBe(true)
  })

  it('diagnoses an unreadable shadowed global Cursor shim without throwing', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-shadow-shim-read-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-shadow-shim-read-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    await initProject({ targetDir: repoRoot, scope: 'global' })
    await initProject({ targetDir: repoRoot, scope: 'project' })
    const shellShim = path.join(homeDir, '.cursor', 'hooks', 'belay-shell-gate.mjs')
    await rm(shellShim)
    await mkdir(shellShim)

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some((issue) => issue.includes('Unable to inspect Cursor hook shim')),
    ).toBe(true)
  })

  it.runIf(process.platform !== 'win32')(
    'accepts a canonical-equivalent project origin when doctor runs through a symlink',
    async () => {
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-canonical-origin-'))
      const linkParent = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-canonical-link-'))
      const linkedRepo = path.join(linkParent, 'repo-link')
      tempDirs.push(repoRoot, linkParent)
      await symlink(repoRoot, linkedRepo, 'dir')
      await initProject({ targetDir: repoRoot })

      const report = await doctorProject({ targetDir: linkedRepo })

      expect(report.issues.some((issue) => issue.includes('origin mismatch'))).toBe(false)
    },
  )

  it('reports a modified Cursor dispatcher as an integrity failure', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-dispatcher-integrity-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'),
      '// modified dispatcher\n',
    )

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some(
        (issue) => issue.includes('hash mismatch') && issue.includes('dispatcher'),
      ),
    ).toBe(true)
  })

  it.each([
    {
      name: 'dispatcher',
      artifactPath: (homeDir: string) =>
        path.join(homeDir, '.cursor', 'belay', 'runtime', 'dispatcher.mjs'),
    },
    {
      name: 'core',
      artifactPath: (homeDir: string) =>
        path.join(homeDir, '.cursor', 'belay', 'runtime', 'core.mjs'),
    },
    {
      name: 'shim',
      artifactPath: (homeDir: string) =>
        path.join(homeDir, '.cursor', 'hooks', 'belay-shell-gate.mjs'),
    },
    {
      name: 'runner',
      artifactPath: (homeDir: string) =>
        path.join(
          homeDir,
          '.cursor',
          'hooks',
          process.platform === 'win32' ? 'belay-runner.ps1' : 'belay-runner',
        ),
    },
  ])('reports a tampered global Cursor $name integrity pin', async ({ artifactPath }) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-global-integrity-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-global-integrity-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    await initProject({
      targetDir: repoRoot,
      scope: 'global',
      judgeProviderId: 'ollama',
    })
    const targetPath = artifactPath(homeDir)
    await writeFile(targetPath, `${await readFile(targetPath, 'utf8')}\n// integrity tamper\n`)

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some(
        (issue) =>
          issue.includes('Integrity verification failed') &&
          issue.includes('hash mismatch') &&
          issue.includes(path.basename(targetPath)),
      ),
    ).toBe(true)
  })

  it('reports a global integrity manifest that omits enforcement artifacts', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-global-pin-set-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-global-pin-set-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME
    await initProject({
      targetDir: repoRoot,
      scope: 'global',
      judgeProviderId: 'ollama',
    })
    const manifestPath = path.join(repoRoot, '.cursor', 'belay', 'integrity-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Record<string, string>
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          files: {
            '.cursor/belay.config.json': manifest.files['.cursor/belay.config.json'],
          },
        },
        null,
        2,
      )}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot })

    expect(report.ok).toBe(false)
    expect(
      report.issues.some(
        (issue) => issue.includes('missing integrity pin') && issue.includes('dispatcher.mjs'),
      ),
    ).toBe(true)
  })

  it('warns when belay.config.json omits version', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const { version: _version, ...withoutVersion } = config
    await writeFile(configPath, `${JSON.stringify(withoutVersion)}\n`)

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.warnings.some((warning) => warning.includes('missing "version"'))).toBe(true)
  })

  it('warns when global Cursor runtime lacks payload-based workspace resolution', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-global-cwd-'))
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-global-home-'))
    tempDirs.push(repoRoot, homeDir)
    process.env.HOME = homeDir
    delete process.env.XDG_CONFIG_HOME

    await initProject({ targetDir: repoRoot, scope: 'global' })

    const corePath = path.join(homeDir, '.cursor', 'belay', 'runtime', 'core.mjs')
    await writeFile(
      corePath,
      [
        'export const RUNTIME_PACKAGE_VERSION = "0.9.2";',
        'export async function runToolGateHook() { const cwd = process.cwd(); return cwd }',
        '',
      ].join('\n'),
    )

    const report = await doctorProject({ targetDir: repoRoot })
    expect(
      report.warnings.some((warning) =>
        warning.includes(
          'Global Cursor runtime appears to resolve hook context from hook process cwd',
        ),
      ),
    ).toBe(true)
  })

  it.each([
    ['allow', ['pnpm release:staging']],
    ['external', ['make deploy']],
  ] as const)('reports a non-empty legacy overrides.%s list as a doctor issue (ADR-005)', async (listName, commands) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-overrides-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        overrides: {
          ...config.overrides,
          [listName]: commands,
        },
      })}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot })
    expect(
      report.issues.some(
        (issue) =>
          issue.includes(`overrides.${listName}`) &&
          issue.includes('forbidden') &&
          issue.includes('ADR-005'),
      ),
    ).toBe(true)
    expect(report.ok).toBe(false)
  })

  it('removes forbidden legacy override lists with doctor --fix', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-fix-overrides-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        overrides: {
          ...config.overrides,
          allow: ['pnpm release:staging'],
          external: ['make deploy'],
        },
      })}\n`,
    )

    const before = await doctorProject({ targetDir: repoRoot })
    expect(before.ok).toBe(false)

    const after = await doctorProject({ targetDir: repoRoot, fix: true })
    expect(
      after.notes.some((note) => note.includes('Removed forbidden legacy shell override lists')),
    ).toBe(true)
    expect(after.issues.some((issue) => issue.includes('overrides.allow'))).toBe(false)
    expect(after.issues.some((issue) => issue.includes('overrides.external'))).toBe(false)

    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    expect(saved.overrides.allow).toEqual([])
    expect(saved.overrides.external).toEqual([])
  })

  it('warns when repo-local approval files remain with control plane enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-cp-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
      `${JSON.stringify({ version: 1, approvals: [{ approvalId: 'belay_stale', kind: 'shell', fingerprint: 'x', repoRoot, reason: 'test', summary: 'x', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }] }, null, 2)}\n`,
    )
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        version: 3,
        controlPlane: {
          enabled: true,
          configDir: path.join(repoRoot, 'cp'),
          integrity: 'hash-pinned',
        },
      })}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot })
    expect(
      report.warnings.some((warning) => warning.includes('Repo-local approval files remain')),
    ).toBe(true)
  })

  it('archives stale repo-local approvals with doctor --fix when control plane is enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-fix-'))
    tempDirs.push(repoRoot)
    const controlPlaneDir = path.join(repoRoot, 'cp')
    await initProject({ targetDir: repoRoot })
    await mkdir(path.join(repoRoot, '.cursor', 'belay'), { recursive: true })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'),
      `${JSON.stringify({ version: 1, approvals: [] })}\n`,
    )
    await mkdir(controlPlaneDir, { recursive: true })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        version: 3,
        controlPlane: { enabled: true, configDir: controlPlaneDir },
      })}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot, fix: true })
    expect(
      report.notes.some((note) => note.includes('Archived stale repo-local approval files')),
    ).toBe(true)
    expect(existsSync(path.join(repoRoot, '.cursor', 'belay', 'pending-approvals.json'))).toBe(
      false,
    )
  })

  it('reports dogfood state when audit mode with fail-closed policy is active', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-dogfood-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    await dogfoodProject({ targetDir: repoRoot })

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.dogfood?.active).toBe(true)
    expect(report.notes.some((note) => note.includes('Dogfood active'))).toBe(true)
  })

  it('warns when containment posture is best-effort', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-posture-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const report = await doctorProject({ targetDir: repoRoot })
    expect(
      report.warnings.some((warning) => warning.includes('Containment posture is best-effort')),
    ).toBe(true)
  })

  it('warns when recovery checkpoint restore lacks a notification channel', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-recovery-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        version: 4,
        policy: {
          ...config.policy,
          transactional: {
            ...config.policy?.transactional,
            enabled: true,
            checkpoint: { enabled: true },
          },
        },
      })}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot })
    expect(
      report.warnings.some((warning) => warning.includes('notification channel is configured')),
    ).toBe(true)
    expect(report.notes.some((note) => note.includes('Recovery restore flow'))).toBe(true)
  })

  it('diagnoses incomplete file-checkpoint prerequisites and clone support', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-file-checkpoint-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        policy: {
          ...config.policy,
          transactional: {
            ...config.policy?.transactional,
            enabled: true,
            fileCheckpoint: {
              ...config.policy?.transactional?.fileCheckpoint,
              enabled: true,
            },
            checkpoint: { enabled: false },
          },
        },
      })}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.notes.some((note) => note.includes('File checkpoint: enabled'))).toBe(true)
    expect(report.notes.some((note) => note.includes('copyStrategy='))).toBe(true)
    expect(
      report.warnings.some((warning) =>
        warning.includes('durable Recovery checkpointing is disabled'),
      ),
    ).toBe(true)
    expect(
      report.warnings.some((warning) => warning.includes('workspace-isolating boundary driver')),
    ).toBe(true)
  })

  it('does not warn about missing git when non-Git file checkpoint is enabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-nongit-'))
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, 'README.md'), '# plain\n')
    const configPath = path.join(repoRoot, '.cursor', 'belay.config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      `${JSON.stringify({
        version: 4,
        adapter: 'cursor',
        installScope: 'project',
        mode: 'enforce',
        policy: {
          unknownLocalEffect: 'allow_flagged',
          transactional: {
            enabled: true,
            fileCheckpoint: { enabled: true, allowNonGit: true },
            checkpoint: { enabled: true },
          },
        },
        audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: false },
        judge: { provider: 'ollama', providerId: 'ollama', model: 'llama3.2', endpoint: null },
        classifier: { sensitivePaths: [], strictChains: true },
        overrides: { allow: [], external: [] },
        sandbox: { enabled: false, runtime: 'none', denyNetworkByDefault: true },
        egress: { enabled: false },
        controlPlane: { enabled: false },
        approvalSigning: { required: false },
        capability: {},
        approval: { flow: 'one_step' },
      })}\n`,
    )

    const report = await doctorProject({ targetDir: repoRoot })
    expect(report.warnings.some((warning) => warning.includes('not a git repository'))).toBe(false)
    expect(report.notes.some((note) => note.includes('file-checkpoint mirror'))).toBe(true)
    expect(report.notes.some((note) => note.includes('File checkpoint eligibility:'))).toBe(true)
  })
})
