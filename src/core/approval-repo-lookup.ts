import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { AdapterName } from '../adapters/layouts/types.js'
import { approvedApprovalsPath, loadConfigFile, pendingApprovalsPath } from '../config-io.js'
import type { ApprovalStateFile } from './types.js'

export type ApprovalRepoLookupResult =
  | { status: 'found'; repoRoot: string }
  | { status: 'ambiguous'; repoRoots: string[] }
  | { status: 'not_found' }

async function approvalStateContainsId(filePath: string, approvalId: string): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as ApprovalStateFile
    return parsed.approvals?.some((entry) => entry.approvalId === approvalId) ?? false
  } catch {
    return false
  }
}

export async function findApprovalRepoRoots(params: {
  approvalId: string
  candidateRepoRoots: string[]
  adapter: AdapterName
}): Promise<ApprovalRepoLookupResult> {
  const matches: string[] = []
  const seen = new Set<string>()

  for (const candidate of params.candidateRepoRoots) {
    const repoRoot = path.resolve(candidate)
    if (seen.has(repoRoot)) {
      continue
    }
    seen.add(repoRoot)

    try {
      const config = await loadConfigFile(repoRoot, params.adapter)
      const pendingPath = pendingApprovalsPath(repoRoot, config)
      const approvedPath = approvedApprovalsPath(repoRoot, config)
      const hasPending = await approvalStateContainsId(pendingPath, params.approvalId)
      const hasApproved = await approvalStateContainsId(approvedPath, params.approvalId)
      if (hasPending || hasApproved) {
        matches.push(repoRoot)
      }
    } catch {
      continue
    }
  }

  if (matches.length === 1) {
    return { status: 'found', repoRoot: matches[0] }
  }
  if (matches.length > 1) {
    return { status: 'ambiguous', repoRoots: matches }
  }
  return { status: 'not_found' }
}

export function formatAmbiguousApprovalRepoMessage(repoRoots: string[]): string {
  return (
    'Belay found the same approval ID in multiple repositories. ' +
    `Open one workspace and retry: ${repoRoots.join(', ')}`
  )
}
