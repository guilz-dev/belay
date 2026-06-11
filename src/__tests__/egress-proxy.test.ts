import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { createEgressProxy, parseConnectTarget } from '../core/egress/proxy-server.js'
import { recordEgressApproval } from '../core/egress-approval.js'
import { loadEgressAllowlist } from '../core/egress/allowlist.js'
import type { ApprovalStateFile } from '../core/types.js'

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

async function listenProxy(
  ctx: Parameters<typeof createEgressProxy>[0],
): Promise<{ server: ReturnType<typeof createEgressProxy>; port: number }> {
  const server = createEgressProxy(ctx)
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
  return { server, port }
}

describe('egress proxy integration', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('blocks unknown egress, allows once after approval, then blocks again', async () => {
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

    const { server, port } = await listenProxy({
      config,
      repoRoot,
      store,
      loadApproved: async () => approved,
    })

    try {
      const blocked = await proxyRequest(port, 'http://blocked.example.com/')
      expect(blocked.status).toBe(403)
      expect(blocked.body).toContain('egress_blocked')
      expect(pending.approvals).toHaveLength(1)

      const approvalId = pending.approvals[0]?.approvalId ?? ''
      const approvalResult = await recordEgressApproval({
        approvalId,
        config,
        store,
        scope: 'once',
      })
      expect(approvalResult.ok).toBe(true)
      expect(approved.approvals).toHaveLength(1)

      const allowed = await proxyRequest(port, 'http://blocked.example.com/')
      expect(allowed.status).not.toBe(403)
      expect(approved.approvals).toHaveLength(0)

      const blockedAgain = await proxyRequest(port, 'http://blocked.example.com/')
      expect(blockedAgain.status).toBe(403)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('persists domain allowlist after approve --scope domain', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-egress-domain-'))
    tempDirs.push(dir)
    const repoRoot = dir
    const pending: ApprovalStateFile = {
      version: 1,
      approvals: [
        {
          approvalId: 'belay_domain1',
          kind: 'egress',
          fingerprint: 'fp-domain',
          repoRoot,
          reason: 'egress_blocked',
          summary: 'CONNECT allowed.example.com:443',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }
    const approved: ApprovalStateFile = { version: 1, approvals: [] }
    const allowlistPath = path.join(dir, 'egress-allowlist.json')
    const store = memoryStore(pending, approved, allowlistPath)
    const config = {
      ...DEFAULT_CONFIG_V3,
      egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true, listenPort: 0 },
    }

    const result = await recordEgressApproval({
      approvalId: 'belay_domain1',
      config,
      store,
      scope: 'domain',
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('allowed.example.com')

    const allowlist = await loadEgressAllowlist(allowlistPath)
    expect(allowlist.domains.some((entry) => entry.host === 'allowed.example.com')).toBe(true)

    const { server, port } = await listenProxy({
      config,
      repoRoot,
      store,
      loadApproved: async () => approved,
    })

    try {
      const response = await proxyRequest(port, 'http://allowed.example.com/')
      expect(response.status).not.toBe(403)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('forwards HTTP with path-only upstream request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-egress-http-'))
    tempDirs.push(dir)
    let seenPath: string | null = null
    const upstream = await new Promise<{ port: number; close: () => void }>((resolve) => {
      const server = http.createServer((req, res) => {
        seenPath = req.url ?? null
        res.writeHead(200)
        res.end('ok')
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('failed to bind upstream')
        }
        resolve({
          port: address.port,
          close: () => server.close(),
        })
      })
    })

    const repoRoot = dir
    const allowlistPath = path.join(dir, 'egress-allowlist.json')
    const store = memoryStore({ version: 1, approvals: [] }, { version: 1, approvals: [] }, allowlistPath)
    const config = {
      ...DEFAULT_CONFIG_V3,
      egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true, listenPort: 0 },
    }
    const { loadEgressAllowlist, saveEgressAllowlist, addDomainToAllowlist } = await import(
      '../core/egress/allowlist.js'
    )
    await saveEgressAllowlist(
      allowlistPath,
      addDomainToAllowlist(await loadEgressAllowlist(allowlistPath), {
        host: '127.0.0.1',
        approvedAt: new Date().toISOString(),
      }),
    )

    const { server, port } = await listenProxy({
      config,
      repoRoot,
      store,
      loadApproved: async () => ({ version: 1, approvals: [] }),
    })

    try {
      const response = await proxyRequest(port, `http://127.0.0.1:${upstream.port}/hello?x=1`)
      expect(response.status).toBe(200)
      expect(seenPath).toBe('/hello?x=1')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      upstream.close()
    }
  })
})

describe('parseConnectTarget', () => {
  it('parses host:port and IPv6 literals', () => {
    expect(parseConnectTarget('example.com:443')).toEqual({ host: 'example.com', port: 443 })
    expect(parseConnectTarget('example.com')).toEqual({ host: 'example.com', port: 443 })
    expect(parseConnectTarget('[::1]:8443')).toEqual({ host: '::1', port: 8443 })
    expect(parseConnectTarget('example.com:bad')).toBeNull()
  })
})
