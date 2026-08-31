import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getAdapterLayout } from '../adapters/layouts/index.js'
import { resolveScopedPaths } from '../adapters/layouts/scope.js'
import type { AdapterName } from '../adapters/layouts/types.js'
import { detectAdapterName } from '../config-io.js'
import { resolveOperationScope } from '../installer/scope-config.js'
import type { WhereOptions, WhereReport } from '../types.js'

export function resolveCliPackageRoot(): string {
  return path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

export async function whereProject(options: WhereOptions = {}): Promise<WhereReport> {
  const cwd = process.cwd()
  const repoRoot = path.resolve(options.targetDir ?? cwd)
  const adapter: AdapterName = options.adapter ?? detectAdapterName(repoRoot)
  const scope = await resolveOperationScope(repoRoot, adapter, options)
  const paths = resolveScopedPaths(getAdapterLayout(adapter), scope, repoRoot)
  const configPresent = existsSync(paths.configPath)

  return {
    cwd,
    repoRoot,
    adapter,
    installScope: scope,
    configPresent,
    cliExecutable: process.argv[1] ? path.resolve(process.argv[1]) : undefined,
    cliPackageRoot: resolveCliPackageRoot(),
    configPath: paths.configPath,
    hooksSettingsPath: paths.hooksSettingsPath,
    hooksDir: paths.hooksDir,
    runtimeDir: paths.runtimeDir,
    skillsDir: paths.skillsDir,
    commandsDir: paths.commandsDir,
  }
}

export function formatWhereReport(report: WhereReport): string {
  const lines = [
    `cwd: ${report.cwd}`,
    `target dir: ${report.repoRoot}`,
    `adapter: ${report.adapter} (scope=${report.installScope})`,
    `config present: ${report.configPresent ? 'yes' : 'no'}`,
    `cli executable: ${report.cliExecutable ?? '(unknown)'}`,
    `cli package: ${report.cliPackageRoot}`,
    `config: ${report.configPath}`,
    `hooks settings: ${report.hooksSettingsPath}`,
    `hooks: ${report.hooksDir}`,
    `runtime: ${report.runtimeDir}`,
    `skills: ${report.skillsDir}`,
  ]
  if (report.commandsDir) {
    lines.push(`commands: ${report.commandsDir}`)
  }
  return `${lines.join('\n')}\n`
}
