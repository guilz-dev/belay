import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ScopedPaths } from '../adapters/layouts/scope.js'
import type { AdapterName } from '../adapters/layouts/types.js'
import { buildRunnerScript, buildWindowsRunnerScript } from '../node-resolution.js'
import {
  renderAuditHook,
  renderBeforeSubmitHook,
  renderCursorDispatcher,
  renderRuntimeCore,
  renderShellGateHook,
  renderToolGateHook,
} from '../templates.js'

async function writeFileMaybeExecutable(
  filePath: string,
  content: string,
  executable = false,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' })
    if (executable) {
      await chmod(temporaryPath, 0o755)
    }
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function writeRuntimeArtifacts(
  adapterName: AdapterName,
  paths: ScopedPaths,
): Promise<void> {
  const { hooksDir, runtimeDir } = paths
  const cursorOrigin =
    adapterName === 'cursor'
      ? paths.scope === 'global'
        ? ({ scope: 'global' } as const)
        : ({ scope: 'project', repoRoot: paths.repoRoot } as const)
      : undefined
  const artifacts = {
    auditHook: renderAuditHook(adapterName, cursorOrigin),
    beforeSubmitHook: renderBeforeSubmitHook(adapterName, cursorOrigin),
    core: await renderRuntimeCore(adapterName),
    dispatcher: adapterName === 'cursor' ? await renderCursorDispatcher() : undefined,
    runner: buildRunnerScript(process.execPath),
    runnerCmd: buildWindowsRunnerScript(process.execPath),
    shellGateHook: renderShellGateHook(adapterName, cursorOrigin),
    toolGateHook: renderToolGateHook(adapterName, cursorOrigin),
  }

  await mkdir(hooksDir, { recursive: true })
  await mkdir(runtimeDir, { recursive: true })
  await writeFileMaybeExecutable(path.join(runtimeDir, 'core.mjs'), artifacts.core)
  if (artifacts.dispatcher !== undefined) {
    await writeFileMaybeExecutable(path.join(runtimeDir, 'dispatcher.mjs'), artifacts.dispatcher)
  }
  await writeFileMaybeExecutable(path.join(hooksDir, 'belay-runner'), artifacts.runner, true)
  await writeFileMaybeExecutable(path.join(hooksDir, 'belay-runner.cmd'), artifacts.runnerCmd)

  await writeFileMaybeExecutable(
    path.join(hooksDir, 'belay-before-submit.mjs'),
    artifacts.beforeSubmitHook,
  )
  await writeFileMaybeExecutable(
    path.join(hooksDir, 'belay-shell-gate.mjs'),
    artifacts.shellGateHook,
  )
  await writeFileMaybeExecutable(path.join(hooksDir, 'belay-tool-gate.mjs'), artifacts.toolGateHook)
  await writeFileMaybeExecutable(path.join(hooksDir, 'belay-audit.mjs'), artifacts.auditHook)
}
