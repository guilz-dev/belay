import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { BelayConfigV3 } from '../config.js'
import { belayStateDir } from '../config.js'
import type { EgressAllowlistEntry, EgressAllowlistFile } from './types.js'

export function egressAllowlistPath(config: BelayConfigV3, repoLocalStateDir: string): string {
  return path.join(belayStateDir(config, repoLocalStateDir), 'egress-allowlist.json')
}

export async function loadEgressAllowlist(filePath: string): Promise<EgressAllowlistFile> {
  if (!existsSync(filePath)) {
    return { version: 1, domains: [] }
  }
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as EgressAllowlistFile
  return {
    version: 1,
    domains: Array.isArray(raw.domains) ? raw.domains : [],
  }
}

export async function saveEgressAllowlist(
  filePath: string,
  state: EgressAllowlistFile,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function isHostAllowlisted(host: string, allowlist: EgressAllowlistFile): boolean {
  const normalized = host.toLowerCase()
  return allowlist.domains.some((entry) => entry.host.toLowerCase() === normalized)
}

export function addDomainToAllowlist(
  allowlist: EgressAllowlistFile,
  entry: EgressAllowlistEntry,
): EgressAllowlistFile {
  const normalized = entry.host.toLowerCase()
  const filtered = allowlist.domains.filter((domain) => domain.host.toLowerCase() !== normalized)
  return {
    version: 1,
    domains: [...filtered, { ...entry, host: normalized }],
  }
}
