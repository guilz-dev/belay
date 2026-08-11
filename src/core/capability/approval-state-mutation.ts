import { constants } from 'node:fs'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { ApprovalStateFile } from '../types.js'
import { upgradeApprovalStateToV3 } from './approval-v3.js'

const DEFAULT_RETRIES = 8
const LOCK_STALE_MS = 5 * 60_000

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function isStaleApprovalLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, 'utf8')
    const [pidText, timestampText] = raw.trim().split(':')
    const timestamp = Number(timestampText)
    if (Number.isFinite(timestamp) && Date.now() - timestamp > LOCK_STALE_MS) {
      return true
    }
    const pid = Number(pidText)
    if (!Number.isFinite(pid)) {
      return true
    }
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  } catch {
    return false
  }
}

async function acquireApprovalStateLock(
  lockPath: string,
  maxRetries: number,
): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
      await handle.writeFile(`${process.pid}:${Date.now()}`)
      await handle.close()
      return async () => {
        await unlink(lockPath).catch(() => {})
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw error
      }
      if (await isStaleApprovalLock(lockPath)) {
        await unlink(lockPath).catch(() => {})
      }
      await sleep(5 + attempt * 8)
    }
  }
  throw new Error(`Failed to acquire approval state lock: ${lockPath}`)
}

export async function mutateApprovalStateWithRetry<T>(params: {
  load: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  write: (filePath: string, state: ApprovalStateFile) => Promise<void>
  mutate: (state: ApprovalStateFile) => { state: ApprovalStateFile; result: T } | null
  maxRetries?: number
}): Promise<T | null> {
  const maxRetries = params.maxRetries ?? DEFAULT_RETRIES
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const loaded = await params.load()
    const lockPath = `${loaded.filePath}.lock`
    let release: (() => Promise<void>) | null = null
    try {
      release = await acquireApprovalStateLock(lockPath, maxRetries)
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
      const verifyBeforeWrite = upgradeApprovalStateToV3((await params.load()).state)
      if ((verifyBeforeWrite.revision ?? 0) !== revision) {
        continue
      }
      await params.write(loaded.filePath, next)
      const verify = upgradeApprovalStateToV3((await params.load()).state)
      if ((verify.revision ?? 0) === revision + 1) {
        return outcome.result
      }
    } finally {
      if (release) {
        await release()
      }
    }
  }
  return null
}
