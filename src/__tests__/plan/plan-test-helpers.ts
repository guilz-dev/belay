import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tempDirs: string[] = []

export async function createPlanTempRepo(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(tempDir)
  return tempDir
}

export async function cleanupPlanTempRepos(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

export function planProviderIdCast<T extends { providerId: string }>(
  providerId: string,
): T['providerId'] {
  return providerId as T['providerId']
}

export function combinedDoctorText(report: {
  issues: string[]
  warnings: string[]
  notes: string[]
}): string {
  return [...report.issues, ...report.warnings, ...report.notes].join('\n')
}
