import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  collectDeadOwnerStaging,
  isOwnerProcessAlive,
  readOwnerMarker,
  removeDeadOwnerStaging,
  writeOwnerMarker,
} from '../core/transactional/file-checkpoint-staging.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('file checkpoint staging owners', () => {
  it('treats the current process as alive', () => {
    expect(isOwnerProcessAlive(process.pid)).toBe(true)
  })

  it('treats unlikely PIDs as dead', () => {
    expect(isOwnerProcessAlive(2_147_483_647)).toBe(false)
  })

  it('round-trips owner markers', async () => {
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-staging-marker-'))
    tempDirs.push(stagingRoot)
    const marker = {
      version: 1 as const,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      resourceRoot: '/tmp/example',
      backend: 'file_checkpoint' as const,
    }

    await writeOwnerMarker(stagingRoot, marker)
    await expect(readOwnerMarker(stagingRoot)).resolves.toEqual(marker)
  })

  it('collects staging without owner markers and retains live owners', async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), 'belay-staging-parent-'))
    tempDirs.push(parentDir)

    const deadDir = path.join(parentDir, 'belay-file-checkpoint-dead')
    const liveDir = path.join(parentDir, 'belay-file-checkpoint-live')
    const missingMarkerDir = path.join(parentDir, 'belay-file-checkpoint-missing')
    await mkdir(deadDir, { recursive: true })
    await mkdir(liveDir, { recursive: true })
    await mkdir(missingMarkerDir, { recursive: true })

    await writeOwnerMarker(deadDir, {
      version: 1,
      pid: 2_147_483_647,
      createdAt: new Date().toISOString(),
      resourceRoot: '/tmp/example',
      backend: 'file_checkpoint',
    })
    await writeOwnerMarker(liveDir, {
      version: 1,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      resourceRoot: '/tmp/example',
      backend: 'file_checkpoint',
    })

    const dead = await collectDeadOwnerStaging(parentDir)
    expect(dead.sort()).toEqual([deadDir, missingMarkerDir].sort())
    expect(dead).not.toContain(liveDir)
  })

  it('removes only dead-owner staging directories', async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), 'belay-staging-remove-'))
    tempDirs.push(parentDir)

    const deadDir = path.join(parentDir, 'belay-file-checkpoint-dead')
    const liveDir = path.join(parentDir, 'belay-file-checkpoint-live')
    await mkdir(deadDir, { recursive: true })
    await mkdir(liveDir, { recursive: true })
    await writeFile(path.join(deadDir, 'owner.json'), '')
    await writeOwnerMarker(liveDir, {
      version: 1,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      resourceRoot: '/tmp/example',
      backend: 'file_checkpoint',
    })

    const removed = await removeDeadOwnerStaging(parentDir)
    expect(removed).toEqual([deadDir])
    await mkdir(path.join(liveDir, 'still-here'), { recursive: true })
  })
})
