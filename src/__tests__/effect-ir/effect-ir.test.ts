import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { combinePolicyDecisions } from '../../core/capability/policy-engine.js'
import {
  buildEffectPlan,
  collectRequirements,
  effectPlanAuditFields,
  hashEffectPlan,
  mergeRequirements,
  peelPackageExecArgv,
  resolveLocalBin,
} from '../../core/effect-ir/index.js'
import { evaluateEffectPlanPolicy } from '../../core/effect-ir/policy.js'
import { verdictTestContext } from '../verdict/helpers.js'

describe('effect-ir', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
    )
  })

  it('peels npx argv and marks call scripts opaque', () => {
    const peel = peelPackageExecArgv(['npx', '-c', 'console.log(1)'])
    expect(peel?.opaque).toBe(true)
    expect(peel?.reason).toBe('npx_call_script')
  })

  it('merges duplicate requirements by strongest evidence', () => {
    const merged = mergeRequirements(
      [
        {
          tag: 'process.exec',
          action: 'process.exec',
          resource: { kind: 'executable', command: 'tsc' },
          evidence: { level: 'possible', signals: ['a'], basis: [] },
          provenance: { segment: 'first' },
        },
      ],
      [
        {
          tag: 'process.exec',
          action: 'process.exec',
          resource: { kind: 'executable', command: 'tsc' },
          evidence: { level: 'certain', signals: ['b'], basis: [] },
          provenance: { segment: 'second' },
        },
      ],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.evidence.level).toBe('certain')
    expect(merged[0]?.provenances).toHaveLength(2)
  })

  it('resolves local bin without network acquire requirement', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-effect-ir-'))
    tempDirs.push(dir)
    const binDir = path.join(dir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, 'tsc'), '#!/usr/bin/env node\n')

    const ctx = verdictTestContext({ cwd: dir, repoRoot: dir })
    const plan = buildEffectPlan({
      tokens: ['npx', 'tsc', '--version'],
      cwd: dir,
      repoRoot: dir,
      inputFingerprint: 'fp-npx-tsc',
      innerRequirements: [],
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const requirements = collectRequirements(plan.root)
    expect(requirements.some((req) => req.tag === 'network.acquire')).toBe(false)
    expect(resolveLocalBin('tsc', dir, dir)?.proven).toBe(true)

    const policy = evaluateEffectPlanPolicy(plan, ctx)
    expect(policy.capabilityRequests.some((request) => request.action === 'process.exec')).toBe(
      true,
    )
    expect(policy.authorizationDecision.outcome).toBe('allow')
  })

  it('does not trust a local bin symlink that escapes the repo', async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), 'belay-effect-repo-'))
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'belay-effect-outside-'))
    tempDirs.push(repoDir, outsideDir)
    const binDir = path.join(repoDir, 'node_modules', '.bin')
    const outsideBin = path.join(outsideDir, 'tsc')
    await mkdir(binDir, { recursive: true })
    await writeFile(outsideBin, '#!/usr/bin/env node\n')
    await symlink(outsideBin, path.join(binDir, 'tsc'))

    expect(resolveLocalBin('tsc', repoDir, repoDir)).toBeNull()
  })

  it('does not search for local bins when cwd is outside the repo', async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), 'belay-effect-repo-'))
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'belay-effect-cwd-'))
    tempDirs.push(repoDir, outsideDir)
    const binDir = path.join(outsideDir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(path.join(binDir, 'tsc'), '#!/usr/bin/env node\n')

    expect(resolveLocalBin('tsc', outsideDir, repoDir)).toBeNull()
  })

  it('requires approval when package acquire is possible', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npx', '-y', 'prettier', '--version'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npx-prettier',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const requirements = collectRequirements(plan.root)
    expect(requirements.some((req) => req.action === 'network.connect')).toBe(true)
    expect(
      requirements.some(
        (req) =>
          req.action === 'fs.write' &&
          req.evidence.signals.includes('package_cache_write') &&
          req.provenance.phase === 'cache_write',
      ),
    ).toBe(true)

    const policy = evaluateEffectPlanPolicy(plan, ctx)
    expect(
      policy.capabilityRequests.some(
        (req) => req.action === 'fs.write' && req.resource.kind === 'package-cache',
      ),
    ).toBe(true)
    expect(policy.authorizationDecision.outcome).toBe('require_approval')
    expect(policy.authorizationDecision.reason).toBe('external_effect')
  })

  it('targets the actual host for an explicit package URL and preserves inner argv', () => {
    const ctx = verdictTestContext()
    const packageUrl = 'https://user:secret@packages.example/tool.tgz?token=abc'
    const plan = buildEffectPlan({
      tokens: ['npx', packageUrl, '--label=a b'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npx-url',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }

    const requirements = collectRequirements(plan.root)
    expect(requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'network.connect',
          resource: expect.objectContaining({ kind: 'network', host: 'packages.example' }),
        }),
      ]),
    )
    const processExec = requirements.find((entry) => entry.action === 'process.exec')
    expect(processExec?.provenance.innerArgv).toEqual([packageUrl, '--label=a b'])
    const audit = JSON.stringify(effectPlanAuditFields(plan))
    expect(audit).not.toContain('--label=a b')
    expect(audit).not.toContain('user:secret')
    expect(audit).not.toContain('token=abc')
  })

  it('keeps package flag acquisition separate from delegated argv', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: [
        'npm',
        'exec',
        '--package=https://packages.example/tool.tgz',
        '--',
        'tool',
        '--version',
      ],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npm-package-url',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const requirements = collectRequirements(plan.root)
    expect(
      requirements.some(
        (entry) =>
          entry.action === 'network.connect' &&
          entry.resource.kind === 'network' &&
          entry.resource.host === 'packages.example',
      ),
    ).toBe(true)
    expect(
      requirements.find((entry) => entry.action === 'process.exec')?.provenance.innerArgv,
    ).toEqual(['tool', '--version'])
  })

  it('retains known acquisition hosts when later launcher syntax is opaque', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npm', 'exec', '--package=https://packages.example/tool.tgz', '--unsupported'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npm-opaque-known',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const requirements = collectRequirements(plan.root)
    expect(
      requirements.some(
        (entry) => entry.resource.kind === 'network' && entry.resource.host === 'packages.example',
      ),
    ).toBe(true)
    expect(requirements.some((entry) => entry.action === 'indeterminate')).toBe(true)
  })

  it('retains scoped npx package acquisition when the executable is ambiguous', () => {
    const ctx = verdictTestContext()
    const peel = peelPackageExecArgv(['npx', '@scope/tool'])
    expect(peel).toMatchObject({
      opaque: true,
      acquisitionSpecs: ['@scope/tool'],
    })
    const plan = buildEffectPlan({
      tokens: ['npx', '@scope/tool'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npx-scoped-package',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const requirements = collectRequirements(plan.root)
    expect(
      requirements.some(
        (entry) =>
          entry.action === 'network.connect' &&
          entry.resource.kind === 'network' &&
          entry.resource.host === 'registry.npmjs.org',
      ),
    ).toBe(true)
    expect(requirements.some((entry) => entry.action === 'fs.write')).toBe(true)
    expect(requirements.some((entry) => entry.action === 'indeterminate')).toBe(true)
  })

  it('retains registry acquisition when package specs mix registry and URL sources', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: [
        'npm',
        'exec',
        '--package=https://packages.example/tool.tgz',
        '--package=prettier',
        '--',
        'tool',
      ],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npm-mixed-sources',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const hosts = collectRequirements(plan.root).flatMap((entry) =>
      entry.resource.kind === 'network' ? [entry.resource.host] : [],
    )
    expect(hosts).toEqual(expect.arrayContaining(['packages.example', 'registry.npmjs.org']))
  })

  it('targets the actual host for git over ssh package specs', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npm', 'exec', '--package=git+ssh://git@code.example/team/tool.git', '--', 'tool'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npm-git-ssh',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const networkResources = collectRequirements(plan.root).flatMap((entry) =>
      entry.resource.kind === 'network' ? [entry.resource] : [],
    )
    expect(networkResources).toContainEqual({
      kind: 'network',
      host: 'code.example',
      protocol: 'ssh',
    })
    expect(networkResources.some((resource) => resource.host === 'registry.npmjs.org')).toBe(false)
  })

  it('targets a short scp-style SSH host for package acquisition', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npx', 'git@forge:team/tool.git'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npx-scp-short-host',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }

    const networkResources = collectRequirements(plan.root).flatMap((entry) =>
      entry.resource.kind === 'network' ? [entry.resource] : [],
    )
    expect(networkResources).toContainEqual({
      kind: 'network',
      host: 'forge',
      protocol: 'ssh',
    })
    expect(networkResources.some((resource) => resource.host === 'registry.npmjs.org')).toBe(false)
  })

  it('does not interpret a package patch protocol as an SSH host', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npx', 'patch:tool#./fix.patch'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npx-patch-protocol',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }

    const networkResources = collectRequirements(plan.root).flatMap((entry) =>
      entry.resource.kind === 'network' ? [entry.resource] : [],
    )
    expect(networkResources.some((resource) => resource.host === 'patch')).toBe(false)
  })

  it('targets GitHub for npm hosted-git shorthand package specs', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npm', 'exec', '--package=owner/tool', '--', 'tool'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npm-github-shorthand',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const networkResources = collectRequirements(plan.root).flatMap((entry) =>
      entry.resource.kind === 'network' ? [entry.resource] : [],
    )
    expect(networkResources).toContainEqual({
      kind: 'network',
      host: 'github.com',
      protocol: 'git',
    })
    expect(networkResources.some((resource) => resource.host === 'registry.npmjs.org')).toBe(false)
  })

  it('does not invent a registry connection for local package specs', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npm', 'exec', '--package=file:../tool', '--', 'tool'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npm-local-package',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const requirements = collectRequirements(plan.root)
    expect(requirements.filter((entry) => entry.action === 'network.connect')).toEqual([])
    expect(requirements.some((entry) => entry.action === 'fs.write')).toBe(true)
  })

  it('does not invent a registry connection for git+file package specs', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npm', 'exec', '--package=git+file:///tmp/tool', '--', 'tool'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npm-git-file-package',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const requirements = collectRequirements(plan.root)
    expect(requirements.some((entry) => entry.action === 'network.connect')).toBe(false)
    expect(requirements.some((entry) => entry.action === 'fs.write')).toBe(true)
  })

  it('uses one package-spec classification even when a same-name local bin exists', async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), 'belay-effect-package-spec-'))
    tempDirs.push(repoDir)
    const binDir = path.join(repoDir, 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await Promise.all(
      ['tool', 'archive.tgz', 'nested'].map((name) =>
        writeFile(path.join(binDir, name), '#!/usr/bin/env node\n'),
      ),
    )

    const cases = [
      { spec: 'owner/tool', expectedHost: 'github.com' },
      { spec: 'file:../tool', expectedHost: null },
      { spec: 'archive.tgz', expectedHost: null },
      { spec: '~/tool', expectedHost: null },
      { spec: 'foo/bar/nested', expectedHost: null },
    ] as const

    for (const fixture of cases) {
      const plan = buildEffectPlan({
        tokens: ['npx', fixture.spec],
        cwd: repoDir,
        repoRoot: repoDir,
        inputFingerprint: `fp-npx-package-spec-${fixture.spec}`,
      })
      expect(plan).not.toBeNull()
      if (!plan) {
        throw new Error('expected effect plan')
      }
      const requirements = collectRequirements(plan.root)
      const networkHosts = requirements.flatMap((entry) =>
        entry.resource.kind === 'network' ? [entry.resource.host] : [],
      )
      expect(networkHosts).toEqual(fixture.expectedHost ? [fixture.expectedHost] : [])
      expect(requirements.some((entry) => entry.action === 'fs.write')).toBe(true)
    }
  })

  it('retains the cache write for a local package when later syntax is opaque', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npm', 'exec', '--package=file:../tool', '--unsupported'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-npm-opaque-local-package',
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('expected effect plan')
    }
    const requirements = collectRequirements(plan.root)
    expect(requirements.some((entry) => entry.action === 'network.connect')).toBe(false)
    expect(requirements.some((entry) => entry.action === 'fs.write')).toBe(true)
    expect(requirements.some((entry) => entry.action === 'indeterminate')).toBe(true)
  })

  it('combines policy decisions with deny over allow', () => {
    const combined = combinePolicyDecisions([
      { outcome: 'allow', reason: 'read_only', signals: [], matchedRule: 'a' },
      {
        outcome: 'require_approval',
        reason: 'external_effect',
        signals: [],
        matchedRule: 'b',
      },
    ])
    expect(combined.outcome).toBe('require_approval')
  })

  it('fails closed for unsupported npx options', () => {
    const peel = peelPackageExecArgv(['npx', '--registry=https://evil.example', 'tsc'])
    expect(peel?.opaque).toBe(true)
    expect(peel?.reason).toBe('npx_unknown_option')
  })

  it('hashes equivalent effect requirements independent of tree order', () => {
    const ctx = verdictTestContext()
    const plan = buildEffectPlan({
      tokens: ['npx', '-y', 'prettier', '--version'],
      cwd: ctx.cwd,
      repoRoot: ctx.repoRoot,
      inputFingerprint: 'fp-order',
    })
    expect(plan?.root.kind).toBe('merge')
    if (!plan || plan.root.kind !== 'merge') {
      throw new Error('expected merge plan')
    }
    const reordered = {
      ...plan,
      root: { ...plan.root, children: [...plan.root.children].reverse() },
    }
    expect(hashEffectPlan(reordered)).toBe(hashEffectPlan(plan))
    expect(hashEffectPlan({ ...plan, completeness: 'partial' })).not.toBe(hashEffectPlan(plan))
  })
})
