import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { notificationConfigIssues, notifyDeny } from '../core/notify.js'

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createRepoRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-notify-'))
  tempDirs.push(dir)
  return dir
}

describe('notify deny', () => {
  it('never serializes an approval token to a webhook', async () => {
    const repoRoot = await createRepoRoot()
    let body = ''
    const token = 'signed.approval.token'
    await notifyDeny(
      { webhookUrl: 'https://example.com/notify' },
      {
        approvalId: 'belay_approve1',
        reason: 'external_effect',
        summary: 'git push origin main',
        repoRoot,
        fingerprint: 'f'.repeat(64),
        // Intentionally injected to prove the payload is allowlisted.
        approvalToken: token,
      } as unknown as Parameters<typeof notifyDeny>[1],
      {
        fetch: vi.fn(async (_url, init) => {
          body = String(init?.body ?? '')
          return new Response('', { status: 200 })
        }),
        execFile: vi.fn(async () => undefined),
      },
    )

    expect(body).not.toContain(token)
    expect(JSON.parse(body)).toEqual({
      approvalId: 'belay_approve1',
      reason: 'external_effect',
      summary: 'git push origin main',
      repoRoot,
      fingerprint: 'f'.repeat(64),
    })
    expect(JSON.parse(body).approvalToken).toBeUndefined()
  })

  it('never exposes BELAY_APPROVAL_TOKEN to command hooks', async () => {
    const repoRoot = await createRepoRoot()
    let env: NodeJS.ProcessEnv | undefined
    await notifyDeny(
      { commandHook: '/usr/local/bin/belay-notify' },
      {
        approvalId: 'belay_approve2',
        reason: 'outside_repo_mutation',
        summary: 'echo hi > ../outside.txt',
        repoRoot,
        fingerprint: 'a'.repeat(64),
      },
      {
        fetch: vi.fn(async () => new Response('', { status: 200 })),
        execFile: vi.fn(async (_file, _args, options) => {
          env = options.env
          return undefined
        }),
      },
    )

    expect(env).toBeDefined()
    expect(env?.BELAY_APPROVAL_ID).toBe('belay_approve2')
    expect(env?.BELAY_REASON).toBe('outside_repo_mutation')
    expect(env?.BELAY_SUMMARY).toBe('echo hi > ../outside.txt')
    expect(env?.BELAY_REPO_ROOT).toBe(repoRoot)
    expect(env?.BELAY_FINGERPRINT).toBe('a'.repeat(64))
    expect(env?.BELAY_APPROVAL_TOKEN).toBeUndefined()
  })

  it('rejects non-HTTPS remote webhook URLs', async () => {
    const repoRoot = await createRepoRoot()
    const fetch = vi.fn(async () => new Response('', { status: 200 }))

    await notifyDeny(
      { webhookUrl: 'http://example.com/notify' },
      {
        approvalId: 'belay_approve3',
        reason: 'external_effect',
        summary: 'curl -X POST https://example.com',
        repoRoot,
        fingerprint: 'b'.repeat(64),
      },
      { fetch, execFile: vi.fn(async () => undefined) },
    )

    expect(fetch).not.toHaveBeenCalled()
    expect(notificationConfigIssues({ webhookUrl: 'http://example.com/notify' }, repoRoot)).toEqual(
      expect.arrayContaining([expect.stringContaining('notifications.webhookUrl must use https')]),
    )
  })

  it.each([
    'http://localhost:8787/notify',
    'http://127.0.0.1:8787/notify',
    'http://[::1]:8787/notify',
  ])('allows HTTP webhook only for local loopback (%s)', async (url) => {
    const repoRoot = await createRepoRoot()
    const fetch = vi.fn(async () => new Response('', { status: 200 }))

    await notifyDeny(
      { webhookUrl: url },
      {
        approvalId: 'belay_approve4',
        reason: 'external_effect',
        summary: 'curl https://localhost',
        repoRoot,
        fingerprint: 'c'.repeat(64),
      },
      { fetch, execFile: vi.fn(async () => undefined) },
    )

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(notificationConfigIssues({ webhookUrl: url }, repoRoot)).toEqual([])
  })

  it('rejects relative command hooks', async () => {
    const repoRoot = await createRepoRoot()
    const execFile = vi.fn(async () => undefined)
    await notifyDeny(
      { commandHook: './scripts/notify.sh' },
      {
        approvalId: 'belay_approve5',
        reason: 'external_effect',
        summary: 'make deploy',
        repoRoot,
        fingerprint: 'd'.repeat(64),
      },
      { fetch: vi.fn(async () => new Response('', { status: 200 })), execFile },
    )

    expect(execFile).not.toHaveBeenCalled()
    expect(notificationConfigIssues({ commandHook: './scripts/notify.sh' }, repoRoot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('notifications.commandHook must be an absolute path'),
      ]),
    )
  })

  it('rejects command hooks located inside the repository', async () => {
    const repoRoot = await createRepoRoot()
    const hookPath = path.join(repoRoot, 'scripts', 'notify.sh')
    const execFile = vi.fn(async () => undefined)
    await notifyDeny(
      { commandHook: hookPath },
      {
        approvalId: 'belay_approve6',
        reason: 'external_effect',
        summary: 'make release',
        repoRoot,
        fingerprint: 'e'.repeat(64),
      },
      { fetch: vi.fn(async () => new Response('', { status: 200 })), execFile },
    )

    expect(execFile).not.toHaveBeenCalled()
    expect(notificationConfigIssues({ commandHook: hookPath }, repoRoot)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('notifications.commandHook must not be inside the repository'),
      ]),
    )
  })

  it('keeps deny notification failure best-effort', async () => {
    const repoRoot = await createRepoRoot()

    await expect(
      notifyDeny(
        {
          webhookUrl: 'https://example.com/notify',
          commandHook: '/usr/local/bin/belay-notify',
        },
        {
          approvalId: 'belay_approve7',
          reason: 'external_effect',
          summary: 'git push origin main',
          repoRoot,
          fingerprint: 'f'.repeat(64),
        },
        {
          fetch: vi.fn(async () => {
            throw new Error('network down')
          }),
          execFile: vi.fn(async () => {
            throw new Error('hook failed')
          }),
        },
      ),
    ).resolves.toBeUndefined()
  })
})
