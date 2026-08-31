import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isPathOutsideRoot } from '../../core/path-utils.js'

import type { AdapterLayout, AdapterName } from './types.js'

export type InstallScope = 'project' | 'global' | 'managed'

export interface ScopedPaths {
  scope: InstallScope
  repoRoot: string
  configPath: string
  hooksSettingsPath: string
  hooksDir: string
  runtimeDir: string
  repoLocalStateDir: string
  skillsDir: string
  commandsDir?: string
}

function canonicalizePotentialPath(inputPath: string): string {
  const unresolvedSegments: string[] = []
  let existingAncestor = path.resolve(inputPath)
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor)
    if (parent === existingAncestor) {
      break
    }
    unresolvedSegments.unshift(path.basename(existingAncestor))
    existingAncestor = parent
  }
  return existsSync(existingAncestor)
    ? path.join(realpathSync(existingAncestor), ...unresolvedSegments)
    : path.resolve(inputPath)
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function resolveTrustedWindowsPowerShellPath(
  systemRoot: string | undefined = process.env.SystemRoot || process.env.WINDIR,
): string {
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('A trusted Windows system root must be an absolute drive path.')
  }
  const hasControlCharacter = [...systemRoot].some((character) => character.charCodeAt(0) < 32)
  if (systemRoot !== systemRoot.trim() || hasControlCharacter || /[%!?*"&|<>^]/.test(systemRoot)) {
    throw new Error(
      'The trusted Windows system root contains unsafe path or cmd.exe expansion characters.',
    )
  }
  if (systemRoot.slice(2).includes(':')) {
    throw new Error('The trusted Windows system root contains an invalid drive path.')
  }
  const normalizedRoot = path.win32.normalize(systemRoot)
  if (!/^[A-Za-z]:\\$/.test(path.win32.parse(normalizedRoot).root)) {
    throw new Error('A trusted Windows system root must be an absolute drive path.')
  }
  return path.win32.join(normalizedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function buildEncodedPowerShellRunnerInvocation(
  executable: string,
  runnerPath: string,
  hookScript: string,
  args: string[],
): string {
  const encodedCommand = Buffer.from(
    [
      '&',
      quotePowerShellLiteral(runnerPath),
      ...[hookScript, ...args].map(quotePowerShellLiteral),
    ].join(' '),
    'utf16le',
  ).toString('base64')
  return `${executable} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`
}

function agentHomeDir(adapter: AdapterName): string {
  const home = os.homedir()
  if (adapter === 'cursor') {
    return path.join(home, '.cursor')
  }
  if (adapter === 'claude') {
    return path.join(home, '.claude')
  }
  return path.join(home, '.codex')
}

function projectAgentDir(adapter: AdapterName, repoRoot: string): string {
  if (adapter === 'cursor') {
    return path.join(repoRoot, '.cursor')
  }
  if (adapter === 'claude') {
    return path.join(repoRoot, '.claude')
  }
  return path.join(repoRoot, '.codex')
}

export function isPathInside(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child)
  const resolvedParent = path.resolve(parent)
  const relative = path.relative(resolvedParent, resolvedChild)
  return relative === '' || (!isPathOutsideRoot(relative) && !path.isAbsolute(relative))
}

export function buildRunnerInvocation(
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
  hookScript: string,
  ...args: string[]
): string {
  const runnerFile = platform === 'win32' ? 'belay-runner.cmd' : 'belay-runner'
  const runnerAbs = path.resolve(hooksDir, runnerFile)
  const relative = path.relative(path.resolve(repoRoot), runnerAbs)
  const useRelative =
    relative.length > 0 && !isPathOutsideRoot(relative) && !path.isAbsolute(relative)
  const runnerRef = useRelative
    ? platform === 'win32'
      ? `.\\${relative.split(path.sep).join('\\')}`
      : `./${relative.split(path.sep).join('/')}`
    : runnerAbs
  return [runnerRef, hookScript, ...args].join(' ')
}

export function buildAbsoluteRunnerInvocation(
  platform: NodeJS.Platform,
  hooksDir: string,
  hookScript: string,
  ...args: string[]
): string {
  const runnerFile = platform === 'win32' ? 'belay-runner.ps1' : 'belay-runner'
  const canonicalHooksDir = canonicalizePotentialPath(hooksDir)
  const runnerPath = path.join(canonicalHooksDir, runnerFile)
  if (platform === 'win32') {
    const powerShellPath = resolveTrustedWindowsPowerShellPath()
    return buildEncodedPowerShellRunnerInvocation(
      `"${powerShellPath}"`,
      runnerPath,
      hookScript,
      args,
    )
  }
  return [`'${runnerPath.replaceAll("'", "'\\''")}'`, hookScript, ...args].join(' ')
}

export function buildLegacyBarePowerShellRunnerInvocation(
  platform: NodeJS.Platform,
  hooksDir: string,
  hookScript: string,
  ...args: string[]
): string {
  if (platform !== 'win32') {
    return buildAbsoluteRunnerInvocation(platform, hooksDir, hookScript, ...args)
  }
  const runnerPath = path.join(canonicalizePotentialPath(hooksDir), 'belay-runner.ps1')
  return buildEncodedPowerShellRunnerInvocation('powershell.exe', runnerPath, hookScript, args)
}

export function buildLegacyQuotedAbsoluteRunnerInvocation(
  platform: NodeJS.Platform,
  hooksDir: string,
  hookScript: string,
  ...args: string[]
): string {
  const runnerFile = platform === 'win32' ? 'belay-runner.cmd' : 'belay-runner'
  const runnerPath = path.join(canonicalizePotentialPath(hooksDir), runnerFile)
  const quotedRunnerPath =
    platform === 'win32' ? `"${runnerPath}"` : `'${runnerPath.replaceAll("'", "'\\''")}'`
  return [quotedRunnerPath, hookScript, ...args].join(' ')
}

export function buildLegacyAbsoluteRunnerInvocation(
  platform: NodeJS.Platform,
  hooksDir: string,
  hookScript: string,
  ...args: string[]
): string {
  const runnerFile = platform === 'win32' ? 'belay-runner.cmd' : 'belay-runner'
  return [path.resolve(hooksDir, runnerFile), hookScript, ...args].join(' ')
}

export function resolveScopedPaths(
  layout: AdapterLayout,
  scope: InstallScope,
  repoRoot: string,
): ScopedPaths {
  const resolvedRepo = path.resolve(repoRoot)
  const adapter = layout.name

  if (scope === 'managed') {
    throw new Error(
      'managed install scope is not implemented yet. Use --scope project (default) or --scope global.',
    )
  }

  const projectAgent = projectAgentDir(adapter, resolvedRepo)
  const project: ScopedPaths = {
    scope: 'project',
    repoRoot: resolvedRepo,
    configPath: layout.configPath(resolvedRepo),
    hooksSettingsPath: layout.hooksSettingsPath(resolvedRepo),
    hooksDir: layout.hooksDir(resolvedRepo),
    runtimeDir: layout.runtimeDir(resolvedRepo),
    repoLocalStateDir: layout.repoLocalStateDir(resolvedRepo),
    skillsDir: path.join(projectAgent, 'skills', 'belay'),
    commandsDir: adapter === 'cursor' ? path.join(projectAgent, 'commands') : undefined,
  }

  if (scope === 'project') {
    return project
  }

  const globalAgent = agentHomeDir(adapter)
  return {
    scope: 'global',
    repoRoot: resolvedRepo,
    configPath: project.configPath,
    hooksSettingsPath:
      adapter === 'cursor'
        ? path.join(globalAgent, 'hooks.json')
        : adapter === 'claude'
          ? path.join(globalAgent, 'settings.json')
          : path.join(globalAgent, 'config.toml'),
    hooksDir: path.join(globalAgent, 'hooks'),
    runtimeDir: path.join(globalAgent, 'belay', 'runtime'),
    repoLocalStateDir: project.repoLocalStateDir,
    skillsDir: path.join(globalAgent, 'skills', 'belay'),
    commandsDir: adapter === 'cursor' ? path.join(globalAgent, 'commands') : undefined,
  }
}

export function resolveInstallScope(
  options: { scope?: InstallScope },
  persisted?: 'project' | 'global',
  fallback: 'project' | 'global' = 'project',
): 'project' | 'global' {
  if (options.scope === 'managed') {
    throw new Error(
      'managed install scope is not implemented yet. Use --scope project (default) or --scope global.',
    )
  }
  if (options.scope === 'global' || options.scope === 'project') {
    return options.scope
  }
  return persisted ?? fallback
}
