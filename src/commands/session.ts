import path from 'node:path'
import process from 'node:process'

import { loadConfigFile } from '../config-io.js'
import {
  boundarySessionStatus,
  runBoundaryAgentCommand,
  startBoundarySession,
} from '../core/capability/boundary-session.js'

export async function sessionStartProject(params: {
  targetDir?: string
  agentCommand?: string
}): Promise<{
  ok: boolean
  message: string
  attestationPath?: string
  exitCode?: number | null
}> {
  const repoRoot = path.resolve(params.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const started = await startBoundarySession({ repoRoot, config })
  if (!params.agentCommand) {
    return {
      ok: true,
      message: `Boundary session started (${started.attestation.driver}); attestation written to ${path.relative(repoRoot, started.attestationPath)}.`,
      attestationPath: started.attestationPath,
    }
  }
  const run = await runBoundaryAgentCommand({
    repoRoot,
    config,
    command: params.agentCommand,
  })
  const exitCode = run.exitCode ?? 1
  return {
    ok: exitCode === 0,
    message: `Boundary session started (${started.attestation.driver}); agent exited with code ${exitCode}.`,
    attestationPath: started.attestationPath,
    exitCode,
  }
}

export async function sessionStatusProject(params: {
  targetDir?: string
  json?: boolean
}): Promise<{
  ok: boolean
  attestationPath: string
  fresh: boolean
  attestation: Awaited<ReturnType<typeof boundarySessionStatus>>['attestation']
}> {
  const repoRoot = path.resolve(params.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const status = await boundarySessionStatus({ repoRoot, config })
  return {
    ok: status.fresh,
    attestationPath: status.attestationPath,
    fresh: status.fresh,
    attestation: status.attestation,
  }
}

export function formatSessionStatusReport(
  report: Awaited<ReturnType<typeof sessionStatusProject>>,
): string {
  if (!report.attestation) {
    return `No boundary attestation at ${report.attestationPath}. Run belay session start.`
  }
  return [
    `Attestation: ${report.attestationPath}`,
    `Driver: ${report.attestation.driver}`,
    `Fresh: ${report.fresh ? 'yes' : 'no'}`,
    `Expires: ${report.attestation.expiresAt}`,
    `Materializes grants: ${report.attestation.materializesGrants ? 'yes' : 'no'}`,
  ].join('\n')
}
