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
    const plan = buildEffectPlan({
      tokens: ['npx', 'https://packages.example/tool.tgz', '--label=a b'],
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
    expect(processExec?.provenance.innerArgv).toEqual([
      'https://packages.example/tool.tgz',
      '--label=a b',
    ])
    expect(JSON.stringify(effectPlanAuditFields(plan))).not.toContain('--label=a b')
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
