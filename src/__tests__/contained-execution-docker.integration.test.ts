import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterAll, describe, expect, it } from 'vitest'

import { isDockerAvailable } from '../core/capability/boundary-driver-container.js'
import { probeContainedDockerBoundary } from '../core/contained-execution/docker.js'

const execFileAsync = promisify(execFile)
const imageReference = 'alpine:3.20'
const dockerAvailable = await isDockerAvailable()
let localImageAvailable = false
if (dockerAvailable) {
  try {
    await execFileAsync('docker', ['image', 'inspect', imageReference])
    localImageAvailable = true
  } catch {
    // The probe must never pull. Integration coverage skips without a pre-provisioned image.
  }
}

describe('contained Docker inspect integration', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })

  it.skipIf(!localImageAvailable)(
    'accepts an actual Docker container only after inspecting every isolation property',
    async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-integration-'))
      roots.push(parent)
      const mirror = path.join(parent, 'mirror')
      await mkdir(mirror)

      const capability = await probeContainedDockerBoundary({
        imageReference,
        hostProbeRoot: mirror,
        guestWorkspacePath: '/workspace/belay-contained-probe',
        resourceLimits: {
          timeoutMs: 10_000,
          memoryMiB: 128,
          cpus: 0.5,
          pids: 32,
        },
      })

      expect(capability).toMatchObject({
        imageId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        networkNone: true,
        readOnlyRoot: true,
        capDropAll: true,
        noNewPrivileges: true,
        proxyEnvironment: 'neutralized-empty',
        tmpfs: { exec: false, mode: 0o1777, sizeBytes: 67_108_864 },
      })
    },
    60_000,
  )
})
