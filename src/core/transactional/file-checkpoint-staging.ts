import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface FileCheckpointOwnerMarker {
  version: 1
  pid: number
  createdAt: string
  resourceRoot: string
  backend: 'file_checkpoint'
}

export function isOwnerProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function writeOwnerMarker(
  stagingRoot: string,
  marker: FileCheckpointOwnerMarker,
): Promise<void> {
  await writeFile(path.join(stagingRoot, 'owner.json'), `${JSON.stringify(marker)}\n`, 'utf8')
}

export async function readOwnerMarker(
  stagingRoot: string,
): Promise<FileCheckpointOwnerMarker | null> {
  try {
    const raw = await readFile(path.join(stagingRoot, 'owner.json'), 'utf8')
    return JSON.parse(raw.trim()) as FileCheckpointOwnerMarker
  } catch {
    return null
  }
}

/** Returns staging directories whose owner process is no longer alive. */
export async function collectDeadOwnerStaging(parentDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(parentDir)
  } catch {
    return []
  }

  const dead: string[] = []
  for (const name of names) {
    if (!name.startsWith('belay-file-checkpoint-')) {
      continue
    }
    const stagingRoot = path.join(parentDir, name)
    const marker = await readOwnerMarker(stagingRoot)
    if (!marker) {
      dead.push(stagingRoot)
      continue
    }
    if (!isOwnerProcessAlive(marker.pid)) {
      dead.push(stagingRoot)
    }
  }
  return dead
}

export async function removeDeadOwnerStaging(parentDir: string): Promise<string[]> {
  const dead = await collectDeadOwnerStaging(parentDir)
  await Promise.all(dead.map((stagingRoot) => rm(stagingRoot, { recursive: true, force: true })))
  return dead
}
