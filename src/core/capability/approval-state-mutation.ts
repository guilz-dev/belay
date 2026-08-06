import type { ApprovalStateFile } from '../types.js'
import { upgradeApprovalStateToV3 } from './approval-v3.js'

const DEFAULT_RETRIES = 5

export async function mutateApprovalStateWithRetry<T>(params: {
  load: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  write: (filePath: string, state: ApprovalStateFile) => Promise<void>
  mutate: (state: ApprovalStateFile) => { state: ApprovalStateFile; result: T } | null
  maxRetries?: number
}): Promise<T | null> {
  const maxRetries = params.maxRetries ?? DEFAULT_RETRIES
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const loaded = await params.load()
    const base = upgradeApprovalStateToV3(loaded.state)
    const revision = base.revision ?? 0
    const outcome = params.mutate(base)
    if (!outcome) {
      return null
    }
    const next: ApprovalStateFile = {
      ...outcome.state,
      version: 3,
      revision: revision + 1,
    }
    const preWrite = upgradeApprovalStateToV3((await params.load()).state)
    if ((preWrite.revision ?? 0) !== revision) {
      continue
    }
    await params.write(loaded.filePath, next)
    const verify = upgradeApprovalStateToV3((await params.load()).state)
    if ((verify.revision ?? 0) === revision + 1) {
      return outcome.result
    }
  }
  return null
}
