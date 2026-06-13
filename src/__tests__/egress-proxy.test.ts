import { mkdtemp, rm } from 'node:fs/promises'
import http, { type RequestListener } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3 } from '../core/config.js'
import { loadEgressAllowlist } from '../core/egress/allowlist.js'
import { createEgressProxy, parseConnectTarget } from '../core/egress/proxy-server.js'
import { recordEgressApproval } from '../core/egress-approval.js'
import type { ApprovalStateFile } from '../core/types.js'

const tempDirs: string[] = []

function memoryStore(
  pending: ApprovalStateFile,
  approved: ApprovalStateFile,
  allowlistPath: string,
) {
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

async function proxyRequest(
  port: number,
  targetUrl: string,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
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
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind proxy'))
        return
      }
      server.removeAllListeners('error')
      resolve(address.port)
    })
  })
  return { server, port }
}

function canSkipSocketBind(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM'
}

async function listenHttpServer(
  handler: RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler)
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind server'))
        return
      }
      server.removeAllListeners('error')
      resolve(address.port)
    })
  })
  return { server, port }
}

describe('egress proxy integration', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('blocks unknown mutating egress, allows once after approval, then blocks again', async () => {
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

    let server: ReturnType<typeof createEgressProxy> | null = null
    let port = 0
    try {
      ;({ server, port } = await listenProxy({
        config,
        repoRoot,
        store,
        loadApproved: async () => approved,
      }))
    } catch (error) {
      if (canSkipSocketBind(error)) {
        return
      }
      throw error
    }

    try {
      const blocked = await proxyRequest(port, 'http://blocked.example.com/', 'POST')
      expect(blocked.status).toBe(403)
      expect(blocked.body).toContain('egress_requires_approval')
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

      const allowed = await proxyRequest(port, 'http://blocked.example.com/', 'POST')
      expect(allowed.status).not.toBe(403)
      expect(approved.approvals).toHaveLength(0)

      const blockedAgain = await proxyRequest(port, 'http://blocked.example.com/', 'POST')
      expect(blockedAgain.status).toBe(403)
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
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
          reason: 'egress_requires_approval',
          summary: 'POST allowed.example.com:443',
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

    let server: ReturnType<typeof createEgressProxy> | null = null
    let port = 0
    try {
      ;({ server, port } = await listenProxy({
        config,
        repoRoot,
        store,
        loadApproved: async () => approved,
      }))
    } catch (error) {
      if (canSkipSocketBind(error)) {
        return
      }
      throw error
    }

    try {
      const response = await proxyRequest(port, 'http://allowed.example.com/', 'POST')
      expect(response.status).not.toBe(403)
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
  })

  it('lets read-only HTTP requests pass without approval', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-egress-read-'))
    tempDirs.push(dir)
    let seenMethod: string | null = null
    let upstream: { server: http.Server; port: number } | null = null
    try {
      upstream = await listenHttpServer((req, res) => {
        seenMethod = req.method ?? null
        res.writeHead(200)
        res.end('ok')
      })
    } catch (error) {
      if (canSkipSocketBind(error)) {
        return
      }
      throw error
    }

    const repoRoot = dir
    const allowlistPath = path.join(dir, 'egress-allowlist.json')
    const store = memoryStore(
      { version: 1, approvals: [] },
      { version: 1, approvals: [] },
      allowlistPath,
    )
    const config = {
      ...DEFAULT_CONFIG_V3,
      egress: { ...DEFAULT_CONFIG_V3.egress, enabled: true, listenPort: 0 },
    }

    let server: ReturnType<typeof createEgressProxy> | null = null
    let port = 0
    try {
      ;({ server, port } = await listenProxy({
        config,
        repoRoot,
        store,
        loadApproved: async () => ({ version: 1, approvals: [] }),
      }))
    } catch (error) {
      if (canSkipSocketBind(error)) {
        await new Promise<void>((resolve) => upstream?.server.close(() => resolve()))
        return
      }
      throw error
    }

    try {
      const response = await proxyRequest(port, `http://127.0.0.1:${upstream.port}/readonly`)
      expect(response.status).toBe(200)
      expect(seenMethod).toBe('GET')
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      await new Promise<void>((resolve) => upstream?.server.close(() => resolve()))
    }
  })

  it('forwards HTTP with path-only upstream request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-egress-http-'))
    tempDirs.push(dir)
    let seenPath: string | null = null
    let seenHost: string | null = null
    let upstream: { server: http.Server; port: number } | null = null
    try {
      upstream = await listenHttpServer((req, res) => {
        seenPath = req.url ?? null
        seenHost = req.headers.host ?? null
        res.writeHead(200)
        res.end('ok')
      })
    } catch (error) {
      if (canSkipSocketBind(error)) {
        return
      }
      throw error
    }

    const repoRoot = dir
    const allowlistPath = path.join(dir, 'egress-allowlist.json')
    const store = memoryStore(
      { version: 1, approvals: [] },
      { version: 1, approvals: [] },
      allowlistPath,
    )
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

    let server: ReturnType<typeof createEgressProxy> | null = null
    let port = 0
    try {
      ;({ server, port } = await listenProxy({
        config,
        repoRoot,
        store,
        loadApproved: async () => ({ version: 1, approvals: [] }),
      }))
    } catch (error) {
      if (canSkipSocketBind(error)) {
        await new Promise<void>((resolve) => upstream?.server.close(() => resolve()))
        return
      }
      throw error
    }

    try {
      const response = await proxyRequest(port, `http://127.0.0.1:${upstream.port}/hello?x=1`)
      expect(response.status).toBe(200)
      expect(seenPath).toBe('/hello?x=1')
      expect(seenHost).toBe(`127.0.0.1:${upstream.port}`)
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      await new Promise<void>((resolve) => upstream?.server.close(() => resolve()))
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
