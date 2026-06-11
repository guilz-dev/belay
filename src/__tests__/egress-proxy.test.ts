import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { createEgressProxy } from '../core/egress/proxy-server.js'
import type { ApprovalStateFile } from '../core/types.js'
import { recordEgressApproval } from '../core/egress-approval.js'

const tempDirs: string[] = []

function memoryStore(pending: ApprovalStateFile, approved: ApprovalStateFile, allowlistPath: string) {
  return {
    allowlistPath,
    async loadPending() {
      return { filePath: '/tmp/pending.json', state: pending }
    },
    async loadApproved() {
      return { filePath: '/tmp/approved.json', state: approved }
    },
    async writePending(_filePath: string, state: ApprovalStateFile) {
      pending.approvals = state.approvals
    },
    async writeApproved(_filePath: string, state: ApprovalStateFile) {
      approved.approvals = state.approvals
    },
  }
}

async function proxyRequest(port: number, targetUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: targetUrl,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('egress proxy integration', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('blocks unknown egress, then allows after approval', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-egress-proxy-'))
    tempDirs.push(dir)
    const repoRoot = dir
    const pending: ApprovalStateFile = { version: 1, approvals: [] }
    const approved: ApprovalStateFile = { version: 1, approvals: [] }
    const allowlistPath = path.join(dir, 'egress-allowlist.json')
    const store = memoryStore(pending, approved, allowlistPath)
    const config = {
      ...DEFAULT_CONFIG_V3,
      egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true, listenPort: 0 },
    }

    const server = createEgressProxy({
      config,
      repoRoot,
      store,
      loadApproved: async () => approved,
    })

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('failed to bind proxy'))
          return
        }
        resolve(address.port)
      })
    })

    try {
      const blocked = await proxyRequest(port, 'http://blocked.example.com/')
      expect(blocked.status).toBe(403)
      expect(blocked.body).toContain('egress_blocked')
      expect(pending.approvals).toHaveLength(1)
      expect(pending.approvals[0]?.kind).toBe('egress')

      const approvalId = pending.approvals[0]?.approvalId
      expect(approvalId).toBeTruthy()

      const approvalResult = await recordEgressApproval({
        approvalId: approvalId ?? '',
        config,
        store,
        scope: 'once',
      })
      expect(approvalResult.ok).toBe(true)
      expect(pending.approvals).toHaveLength(0)
      expect(approved.approvals).toHaveLength(1)

      const allowed = await proxyRequest(port, 'http://blocked.example.com/')
      expect(allowed.status).not.toBe(403)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
