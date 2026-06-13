import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ScopedPaths } from '../adapters/layouts/scope.js'
import type { AdapterName } from '../adapters/layouts/types.js'
import { buildRunnerScript, buildWindowsRunnerScript } from '../node-resolution.js'
import {
  renderAuditHook,
  renderBeforeSubmitHook,
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
  await writeFile(filePath, content, 'utf8')
  if (executable) {
    await chmod(filePath, 0o755)
  }
}

export async function writeRuntimeArtifacts(
  adapterName: AdapterName,
  paths: ScopedPaths,
): Promise<void> {
  const { hooksDir, runtimeDir } = paths
  await mkdir(hooksDir, { recursive: true })
  await mkdir(runtimeDir, { recursive: true })

  await writeFileMaybeExecutable(
    path.join(hooksDir, 'belay-before-submit.mjs'),
    renderBeforeSubmitHook(),
  )
  await writeFileMaybeExecutable(path.join(hooksDir, 'belay-shell-gate.mjs'), renderShellGateHook())
  await writeFileMaybeExecutable(path.join(hooksDir, 'belay-tool-gate.mjs'), renderToolGateHook())
  await writeFileMaybeExecutable(path.join(hooksDir, 'belay-audit.mjs'), renderAuditHook())
  await writeFileMaybeExecutable(
    path.join(runtimeDir, 'core.mjs'),
    await renderRuntimeCore(adapterName),
  )
  await writeFileMaybeExecutable(
    path.join(hooksDir, 'belay-runner'),
    buildRunnerScript(process.execPath),
    true,
  )
  await writeFileMaybeExecutable(
    path.join(hooksDir, 'belay-runner.cmd'),
    buildWindowsRunnerScript(process.execPath),
  )
}
