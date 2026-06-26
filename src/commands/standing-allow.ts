import path from 'node:path'

import { loadConfigFile, repoLocalStateDirFor } from '../config-io.js'
import type { GatedActionKind } from '../core/gate-contract.js'
import {
  loadStandingAllow,
  revokeStandingAllowEntry,
  saveStandingAllow,
  standingAllowFile,
} from '../core/standing-allow.js'

export interface RevokeStandingAllowOptions {
  targetDir?: string
  fingerprint: string
  kind?: GatedActionKind
}

export async function revokeStandingAllow(
  options: RevokeStandingAllowOptions,
): Promise<{ ok: boolean; message: string }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const filePath = standingAllowFile(config, repoLocalStateDirFor(repoRoot, config))
  const state = await loadStandingAllow(filePath)
  const kind = options.kind ?? 'shell'
  const { state: next, removed } = revokeStandingAllowEntry(state, {
    kind,
    fingerprint: options.fingerprint,
    repoRoot,
  })

  if (!removed) {
    return {
      ok: false,
      message: `Standing-allow entry not found for ${kind} fingerprint ${options.fingerprint}.`,
    }
  }

  await saveStandingAllow(filePath, next)
  return {
    ok: true,
    message: `Revoked standing-allow for ${kind} fingerprint ${options.fingerprint}.`,
  }
}
