import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { doctorProject } from '../commands/doctor.js'
import { loadConfigFile } from '../config-io.js'
import { initProject, upgradeProject } from '../installer.js'

const tempDirs: string[] = []
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(tempDir)
  return tempDir
}

async function runManagedCommand(
  command: string,
  payload: Record<string, unknown>,
  cwd: string,
  markerPath: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(command, {
    cwd,
    env: { ...process.env, BELAY_INTEGRATION_CORE_MARKER: markerPath },
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  child.stdin.end(JSON.stringify(payload))
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8').trim(),
    stderr: Buffer.concat(stderr).toString('utf8').trim(),
  }
}

async function managedCommand(
  hooksPath: string,
  event: 'beforeShellExecution' | 'preToolUse',
  matcher?: string,
): Promise<string> {
  const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as {
    hooks: Record<string, Array<{ command?: unknown; matcher?: unknown }> | undefined>
  }
  const command = hooks.hooks[event]?.find((entry) => entry.matcher === matcher)?.command
  if (typeof command !== 'string') {
    throw new Error(`missing managed ${event} command in ${hooksPath}`)
  }
  return command
}

async function prependCoreMarker(runtimeDir: string, source: string): Promise<void> {
  const corePath = path.join(runtimeDir, 'core.mjs')
  const core = await readFile(corePath, 'utf8')
  const marker = `import { appendFileSync as appendBelayIntegrationMarker } from 'node:fs'\nif (process.env.BELAY_INTEGRATION_CORE_MARKER) appendBelayIntegrationMarker(process.env.BELAY_INTEGRATION_CORE_MARKER, ${JSON.stringify(`${source}\n`)})\n`
  await writeFile(corePath, `${marker}${core}`)
}

async function auditRecords(repoRoot: string): Promise<Array<Record<string, unknown>>> {
  const config = await loadConfigFile(repoRoot)
  const raw = await readFile(path.join(repoRoot, config.audit.logPath), 'utf8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function markerLoads(markerPath: string): Promise<string[]> {
  try {
    return (await readFile(markerPath, 'utf8')).split('\n').filter(Boolean)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

interface InstalledSources {
  homeRoot: string
  projectA: string
  projectB: string
  globalCursorRoot: string
  projectACursorRoot: string
  projectBCursorRoot: string
  markerPath: string
}

async function installGlobalAndTwoProjects(): Promise<InstalledSources> {
  const homeRoot = await createTempDir('agent-belay-cursor-home-')
  const projectA = await createTempDir('agent-belay-cursor-project-a-')
  const projectB = await createTempDir('agent-belay-cursor-project-b-')
  process.env.HOME = homeRoot
  process.env.USERPROFILE = homeRoot

  await initProject({ targetDir: projectA, scope: 'global' })
  await initProject({ targetDir: projectA, scope: 'project' })
  await initProject({ targetDir: projectB, scope: 'project' })

  const globalCursorRoot = path.join(homeRoot, '.cursor')
  const projectACursorRoot = path.join(projectA, '.cursor')
  const projectBCursorRoot = path.join(projectB, '.cursor')
  await prependCoreMarker(path.join(globalCursorRoot, 'belay', 'runtime'), 'global')
  await prependCoreMarker(path.join(projectACursorRoot, 'belay', 'runtime'), 'project-a')
  await prependCoreMarker(path.join(projectBCursorRoot, 'belay', 'runtime'), 'project-b')
  await writeFile(path.join(projectA, (await loadConfigFile(projectA)).audit.logPath), '')

  return {
    homeRoot,
    projectA,
    projectB,
    globalCursorRoot,
    projectACursorRoot,
    projectBCursorRoot,
    markerPath: path.join(homeRoot, 'core-imports.txt'),
  }
}

async function invokeAllSources(
  sources: InstalledSources,
  event: 'beforeShellExecution' | 'preToolUse',
  payload: Record<string, unknown>,
  matcher?: string,
): Promise<Array<{ exitCode: number; stdout: string; stderr: string }>> {
  const invocations = [
    [sources.globalCursorRoot, sources.homeRoot],
    [sources.projectBCursorRoot, sources.projectB],
    [sources.projectACursorRoot, sources.projectA],
  ] as const
  const results = []
  for (const [cursorRoot, cwd] of invocations) {
    results.push(
      await runManagedCommand(
        await managedCommand(path.join(cursorRoot, 'hooks.json'), event, matcher),
        payload,
        cwd,
        sources.markerPath,
      ),
    )
  }
  return results
}

describe.sequential('Cursor hook source precedence integration', () => {
  beforeEach(() => {
    process.env.BELAY_DETERMINISTIC_JUDGE = '1'
  })

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserProfile
    }
    delete process.env.BELAY_DETERMINISTIC_JUDGE
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('surfaces marker read failures other than a missing file', async () => {
    const directoryPath = await createTempDir('agent-belay-cursor-marker-directory-')

    await expect(markerLoads(directoryPath)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('runs one effective gate when Cursor invokes global and two project sources', async () => {
    const sources = await installGlobalAndTwoProjects()
    const payload = {
      command: 'git status',
      cwd: sources.projectA,
      workspace_roots: [sources.projectB, sources.projectA],
    }
    const results = await invokeAllSources(sources, 'beforeShellExecution', payload)

    expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0])
    expect(results.map((result) => JSON.parse(result.stdout))).toEqual([
      { permission: 'allow' },
      { permission: 'allow' },
      { permission: 'allow' },
    ])
    expect(await markerLoads(sources.markerPath)).toEqual(['project-a'])
    expect(await auditRecords(sources.projectA)).toMatchObject([{ event: 'beforeShellExecution' }])
  })

  it('runs a project-only owner once', async () => {
    const homeRoot = await createTempDir('agent-belay-cursor-home-')
    const projectRoot = await createTempDir('agent-belay-cursor-project-only-')
    process.env.HOME = homeRoot
    process.env.USERPROFILE = homeRoot
    await initProject({ targetDir: projectRoot, scope: 'project' })
    const cursorRoot = path.join(projectRoot, '.cursor')
    await prependCoreMarker(path.join(cursorRoot, 'belay', 'runtime'), 'project-only')
    await writeFile(path.join(projectRoot, (await loadConfigFile(projectRoot)).audit.logPath), '')
    const markerPath = path.join(homeRoot, 'project-only-core-imports.txt')

    const result = await runManagedCommand(
      await managedCommand(path.join(cursorRoot, 'hooks.json'), 'beforeShellExecution'),
      { command: 'git status', cwd: projectRoot },
      projectRoot,
      markerPath,
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ permission: 'allow' })
    expect(await markerLoads(markerPath)).toEqual(['project-only'])
    expect(await auditRecords(projectRoot)).toHaveLength(1)
  })

  it.each([
    {
      name: 'runner',
      artifactPath: (cursorRoot: string) =>
        path.join(
          cursorRoot,
          'hooks',
          process.platform === 'win32' ? 'belay-runner.ps1' : 'belay-runner',
        ),
    },
    {
      name: 'shim',
      artifactPath: (cursorRoot: string) => path.join(cursorRoot, 'hooks', 'belay-shell-gate.mjs'),
    },
    {
      name: 'dispatcher',
      artifactPath: (cursorRoot: string) =>
        path.join(cursorRoot, 'belay', 'runtime', 'dispatcher.mjs'),
    },
  ])('marks the gate failClosed when its $name cannot start', async ({ artifactPath }) => {
    const homeRoot = await createTempDir('agent-belay-cursor-home-')
    const projectRoot = await createTempDir('agent-belay-cursor-host-fail-closed-')
    process.env.HOME = homeRoot
    process.env.USERPROFILE = homeRoot
    await initProject({ targetDir: projectRoot, scope: 'project' })
    const cursorRoot = path.join(projectRoot, '.cursor')
    const hooks = JSON.parse(await readFile(path.join(cursorRoot, 'hooks.json'), 'utf8')) as {
      hooks: { beforeShellExecution?: Array<{ command?: unknown; failClosed?: unknown }> }
    }
    const definition = hooks.hooks.beforeShellExecution?.[0]
    if (typeof definition?.command !== 'string') {
      throw new Error('missing managed beforeShellExecution hook')
    }
    await rm(artifactPath(cursorRoot), { force: true })

    const result = await runManagedCommand(
      definition.command,
      { command: 'git status', cwd: projectRoot },
      projectRoot,
      path.join(homeRoot, 'missing-entrypoint-core-imports.txt'),
    )

    expect(definition.failClosed).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })

  it('runs a global-only owner once', async () => {
    const homeRoot = await createTempDir('agent-belay-cursor-home-')
    const projectRoot = await createTempDir('agent-belay-cursor-global-only-')
    process.env.HOME = homeRoot
    process.env.USERPROFILE = homeRoot
    await initProject({ targetDir: projectRoot, scope: 'global' })
    const globalCursorRoot = path.join(homeRoot, '.cursor')
    await prependCoreMarker(path.join(globalCursorRoot, 'belay', 'runtime'), 'global-only')
    await writeFile(path.join(projectRoot, (await loadConfigFile(projectRoot)).audit.logPath), '')
    const markerPath = path.join(homeRoot, 'global-only-core-imports.txt')

    const result = await runManagedCommand(
      await managedCommand(path.join(globalCursorRoot, 'hooks.json'), 'beforeShellExecution'),
      { command: 'git status', cwd: projectRoot },
      homeRoot,
      markerPath,
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ permission: 'allow' })
    expect(await markerLoads(markerPath)).toEqual(['global-only'])
    expect(await auditRecords(projectRoot)).toHaveLength(1)
  })

  it('keeps the global source neutral for an uninitialized repository', async () => {
    const homeRoot = await createTempDir('agent-belay-cursor-home-')
    const configuredRoot = await createTempDir('agent-belay-cursor-configured-')
    const uninitializedRoot = await createTempDir('agent-belay-cursor-uninitialized-')
    process.env.HOME = homeRoot
    process.env.USERPROFILE = homeRoot
    await initProject({ targetDir: configuredRoot, scope: 'global' })
    const globalCursorRoot = path.join(homeRoot, '.cursor')
    await prependCoreMarker(path.join(globalCursorRoot, 'belay', 'runtime'), 'global')
    const markerPath = path.join(homeRoot, 'uninitialized-core-imports.txt')

    const result = await runManagedCommand(
      await managedCommand(path.join(globalCursorRoot, 'hooks.json'), 'beforeShellExecution'),
      { command: 'git status', cwd: uninitializedRoot },
      homeRoot,
      markerPath,
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ permission: 'allow' })
    expect(await markerLoads(markerPath)).toEqual([])
  })

  it('fails closed without core execution when the selected project owner is incomplete', async () => {
    const sources = await installGlobalAndTwoProjects()
    await rm(path.join(sources.projectACursorRoot, 'belay', 'runtime', 'core.mjs'))
    const results = await invokeAllSources(sources, 'beforeShellExecution', {
      command: 'git status',
      cwd: sources.projectA,
      workspace_roots: [sources.projectB, sources.projectA],
    })

    expect(results.map((result) => JSON.parse(result.stdout))).toEqual([
      { permission: 'allow' },
      { permission: 'allow' },
      {
        permission: 'deny',
        user_message: 'belay project hook installation is incomplete.',
      },
    ])
    expect(await markerLoads(sources.markerPath)).toEqual([])
    expect(await auditRecords(sources.projectA)).toEqual([])
  })

  it.runIf(process.platform !== 'win32')(
    'canonicalizes a symlinked action repository to one project owner',
    async () => {
      const sources = await installGlobalAndTwoProjects()
      const linkRoot = await createTempDir('agent-belay-cursor-links-')
      const projectLink = path.join(linkRoot, 'project-a-link')
      await symlink(sources.projectA, projectLink, 'dir')

      const results = await invokeAllSources(sources, 'beforeShellExecution', {
        command: 'git status',
        cwd: projectLink,
        workspace_roots: [sources.projectB, projectLink],
      })

      expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0])
      expect(await markerLoads(sources.markerPath)).toEqual(['project-a'])
      expect(await auditRecords(sources.projectA)).toHaveLength(1)
    },
  )

  it.runIf(process.platform !== 'win32')(
    'keeps the canonical project origin after its install-time symlink is removed',
    async () => {
      const homeRoot = await createTempDir('agent-belay-cursor-home-')
      const projectRoot = await createTempDir('agent-belay-cursor-durable-origin-')
      const linkParent = await createTempDir('agent-belay-cursor-origin-link-parent-')
      const projectLink = path.join(linkParent, 'project-link')
      process.env.HOME = homeRoot
      process.env.USERPROFILE = homeRoot
      await symlink(projectRoot, projectLink, 'dir')
      await initProject({
        targetDir: projectLink,
        scope: 'project',
        judgeProviderId: 'ollama',
      })
      const cursorRoot = path.join(projectRoot, '.cursor')
      const auditPath = path.join(projectRoot, (await loadConfigFile(projectRoot)).audit.logPath)
      await writeFile(auditPath, '')
      await rm(projectLink)

      const first = await runManagedCommand(
        await managedCommand(path.join(cursorRoot, 'hooks.json'), 'beforeShellExecution'),
        { command: 'git push origin main', cwd: projectRoot },
        projectRoot,
        path.join(homeRoot, 'durable-origin-core-imports.txt'),
      )
      const beforeUpgradeDoctor = await doctorProject({ targetDir: projectRoot })

      expect(first.exitCode).toBe(0)
      expect(JSON.parse(first.stdout)).toMatchObject({ permission: 'deny' })
      expect(await auditRecords(projectRoot)).toHaveLength(1)
      expect(beforeUpgradeDoctor.ok).toBe(true)

      await upgradeProject({ targetDir: projectRoot })
      const hooks = JSON.parse(await readFile(path.join(cursorRoot, 'hooks.json'), 'utf8')) as {
        hooks: { beforeShellExecution?: Array<{ command?: unknown }> }
      }
      expect(hooks.hooks.beforeShellExecution).toHaveLength(1)
      const second = await runManagedCommand(
        await managedCommand(path.join(cursorRoot, 'hooks.json'), 'beforeShellExecution'),
        { command: 'git push origin main', cwd: projectRoot },
        projectRoot,
        path.join(homeRoot, 'durable-origin-core-imports.txt'),
      )
      expect(second.exitCode).toBe(0)
      expect(JSON.parse(second.stdout)).toMatchObject({ permission: 'deny' })
      expect(await auditRecords(projectRoot)).toHaveLength(2)
    },
  )

  it('keeps distinct canonical Shell events as separate effective executions', async () => {
    const sources = await installGlobalAndTwoProjects()
    const payload = {
      command: 'git status',
      tool_name: 'Shell',
      tool_input: {
        command: 'git status',
        working_directory: sources.projectA,
      },
      cwd: sources.projectB,
      workspace_roots: [sources.projectB, sources.projectA],
    }

    const beforeShellResults = await invokeAllSources(sources, 'beforeShellExecution', payload)
    const preToolUseResults = await invokeAllSources(sources, 'preToolUse', payload, 'Shell')

    expect(beforeShellResults.map((result) => result.exitCode)).toEqual([0, 0, 0])
    expect(beforeShellResults.map((result) => JSON.parse(result.stdout))).toEqual([
      { permission: 'allow' },
      { permission: 'allow' },
      { permission: 'allow' },
    ])
    expect(preToolUseResults.map((result) => result.exitCode)).toEqual([0, 0, 0])
    expect(preToolUseResults.map((result) => JSON.parse(result.stdout))).toEqual([
      { permission: 'allow' },
      { permission: 'allow' },
      { permission: 'allow' },
    ])

    expect(await markerLoads(sources.markerPath)).toEqual(['project-a', 'project-a'])
    expect((await auditRecords(sources.projectA)).map((record) => record.event)).toEqual([
      'beforeShellExecution',
      'preToolUse',
    ])
  })
})
