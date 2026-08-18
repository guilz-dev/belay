import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG_V3, normalizeConfig } from '../core/config.js'
import { isContainedUnknownExecutionEligible } from '../core/contained-execution/eligibility.js'
import { collectRequirements } from '../core/effect-ir/build.js'
import type { EffectPlan, EffectRequirement } from '../core/effect-ir/types.js'
import type { GatedAction, GatedActionKind } from '../core/gate-contract.js'
import type { ClassifyResult } from '../core/types.js'
import { classifyShellCore } from './helpers/shell-classify.js'

const repoRoot = '/workspace/project'
const cwd = path.join(repoRoot, 'app')

type ContainedUnknownResult = ClassifyResult & {
  axes: NonNullable<ClassifyResult['axes']>
  effectPlan: EffectPlan
}

function configWithContainedExecution(enabled = true) {
  return normalizeConfig({
    ...DEFAULT_CONFIG_V3,
    sandbox: {
      enabled,
      runtime: enabled ? 'container' : 'none',
      denyNetworkByDefault: true,
      containedExecution: {
        enabled,
        image: enabled ? 'registry.example/contained-runner:latest' : null,
        timeoutMs: 30_000,
        memoryMiB: 2048,
        cpus: 2,
        pids: 256,
      },
    },
  })
}

function gate(
  kind: GatedActionKind = 'shell',
  root = repoRoot,
): Pick<GatedAction, 'kind' | 'repoRoot'> {
  return { kind, repoRoot: root }
}

describe('contained unknown execution eligibility', () => {
  it.each([
    'fictional-runner verify',
    'imaginary-probe verify',
    'made-up-checker inspect',
    "bin/rails runner 'Record.count'",
    'bundle exec rspec --dry-run',
  ])('uses the same effect-based decision for unknown local command %s', async (command) => {
    const result = await classifyShellCore(command, cwd, repoRoot)

    expect(result.reason).toBe('unknown_local_effect')
    expect(
      isContainedUnknownExecutionEligible(configWithContainedExecution(), gate(), result),
    ).toBe(true)
  })

  it.each([
    'eval fictional-runner verify',
    "sh -c 'fictional-runner verify'",
    "node -e 'fictional-runner verify'",
    'command eval fictional-runner verify',
    'builtin eval fictional-runner verify',
    "exec sh -c 'fictional-runner verify'",
    'env command eval fictional-runner verify',
    'env -- command eval fictional-runner verify',
    "sudo exec sh -c 'fictional-runner verify'",
    "sudo -- exec sh -c 'fictional-runner verify'",
    "sudo -u root exec sh -c 'fictional-runner verify'",
    "sudo --user=root exec sh -c 'fictional-runner verify'",
    'command -- eval fictional-runner verify',
    'command -p eval fictional-runner verify',
    'builtin -- eval fictional-runner verify',
    "exec -- sh -c 'fictional-runner verify'",
    "exec -a contained-runner sh -c 'fictional-runner verify'",
    "time sh -c 'fictional-runner verify'",
    "time -p sh -c 'fictional-runner verify'",
    "nice sh -c 'fictional-runner verify'",
    "nice -n 1 sh -c 'fictional-runner verify'",
    'env -u HOME command eval fictional-runner verify',
    "ionice sh -c 'fictional-runner verify'",
    "stdbuf sh -c 'fictional-runner verify'",
    "setsid sh -c 'fictional-runner verify'",
    "nohup sh -c 'fictional-runner verify'",
  ])('rejects dynamically evaluated recursive shell grammar: %s', async (command) => {
    const result = await classifyShellCore(command, cwd, repoRoot)

    expect(result.reason).toBe('unknown_local_effect')
    expect(result.effectPlan?.signals).toContain('dynamic_shell_evaluation')
    if (!result.effectPlan) {
      throw new Error('expected a dynamic evaluation EffectPlan')
    }
    expect(collectRequirements(result.effectPlan.root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.objectContaining({
            signals: expect.arrayContaining(['dynamic_shell_evaluation']),
          }),
        }),
      ]),
    )
    expect(
      isContainedUnknownExecutionEligible(configWithContainedExecution(), gate(), result),
    ).toBe(false)
  })

  it.each([
    "env -S 'sh -c fictional-runner verify'",
    "ionice -c 2 sh -c 'fictional-runner verify'",
    "stdbuf -o 0 sh -c 'fictional-runner verify'",
    "setsid -f sh -c 'fictional-runner verify'",
    "nohup -- sh -c 'fictional-runner verify'",
    "xargs -n 1 sh -c 'fictional-runner verify'",
  ])('fails closed when a wrapper option does not prove its target: %s', async (command) => {
    const result = await classifyShellCore(command, cwd, repoRoot)

    expect(result.effectPlan?.opacity).toBe('opaque')
    expect(
      isContainedUnknownExecutionEligible(configWithContainedExecution(), gate(), result),
    ).toBe(false)
  })

  it.each([
    'xargs fictional-runner verify',
    'command xargs fictional-runner verify',
    'time xargs fictional-runner verify',
    'env sudo xargs fictional-runner verify',
    'sudo command xargs -I{} fictional-runner verify',
  ])('rejects stdin-dynamic xargs through transparent wrappers: %s', async (command) => {
    const result = await classifyShellCore(command, cwd, repoRoot)

    expect(result.effectPlan?.opacity).toBe('opaque')
    expect(result.effectPlan?.signals).toContain('shell.xargs_stdin_dynamic')
    if (!result.effectPlan) {
      throw new Error('expected an xargs EffectPlan')
    }
    expect(collectRequirements(result.effectPlan.root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'indeterminate',
          evidence: expect.objectContaining({
            signals: expect.arrayContaining(['shell.xargs_stdin_dynamic']),
          }),
        }),
      ]),
    )
    expect(
      isContainedUnknownExecutionEligible(configWithContainedExecution(), gate(), result),
    ).toBe(false)
  })

  it.each([
    'command -v eval',
    'command -V eval',
  ])('keeps command inspection distinct from dynamic evaluation: %s', async (command) => {
    const result = await classifyShellCore(command, cwd, repoRoot)

    expect(result.effectPlan?.signals).not.toContain('dynamic_shell_evaluation')
    expect(result.verdict).toBe('allow')
    expect(result.effectPlan?.root).toEqual(
      expect.objectContaining({
        kind: 'exec',
        requirements: expect.arrayContaining([
          expect.objectContaining({
            action: 'process.exec',
            resource: expect.objectContaining({ kind: 'executable', operation: 'inspect' }),
          }),
        ]),
      }),
    )
  })

  it('fails closed when command wrapper options do not prove a target grammar', async () => {
    const result = await classifyShellCore(
      'command -not-an-option eval fictional-runner verify',
      cwd,
      repoRoot,
    )

    expect(result.effectPlan?.opacity).toBe('opaque')
    expect(
      isContainedUnknownExecutionEligible(configWithContainedExecution(), gate(), result),
    ).toBe(false)
  })

  it('fails closed when nested wrapper peeling exceeds its bound', async () => {
    const command = [
      ...Array.from({ length: 33 }, () => 'command'),
      'eval',
      'fictional-runner',
      'verify',
    ].join(' ')
    const result = await classifyShellCore(command, cwd, repoRoot)

    expect(result.effectPlan?.opacity).toBe('opaque')
    expect(
      isContainedUnknownExecutionEligible(configWithContainedExecution(), gate(), result),
    ).toBe(false)
  })

  it('accepts a statically expanded local launcher recipe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-launcher-'))
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { verify: 'fictional-runner verify' } }),
      )
      const result = await classifyShellCore('npm run verify', root, root)

      expect(result.reason).toBe('unknown_local_effect')
      expect(result.effectPlan?.opacity).toBe('recursive')
      expect(result.effectPlan?.signals).not.toContain('dynamic_shell_evaluation')
      expect(
        isContainedUnknownExecutionEligible(
          configWithContainedExecution(),
          gate('shell', root),
          result,
        ),
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects every effect or signal outside the contained local subset', () => {
    const baseline = containedUnknownResult()
    const config = configWithContainedExecution()
    const risky: Array<[string, ClassifyResult]> = [
      ['network', withRequirement(baseline, networkRequirement())],
      ['secret', withRequirement(baseline, secretRequirement())],
      ['control plane', withRequirement(baseline, controlPlaneRequirement())],
      ['outside workspace', { ...baseline, axes: { ...baseline.axes, location: 'repo_outside' } }],
      ['Tier0', withSignals(baseline, ['tier0_future_remote_mutation'])],
      ['high stakes', withSignals(baseline, ['high_stakes_path'])],
      ['pipe-to-shell', withSignals(baseline, ['pipe_to_shell'])],
      ['dynamic evaluation', withSignals(baseline, ['dynamic_shell_evaluation'])],
      ['command substitution', withSignals(baseline, ['command_substitution'])],
      [
        'unparseable shell',
        { ...baseline, effectPlan: { ...baseline.effectPlan, opacity: 'unparseable' } },
      ],
    ]

    for (const [category, result] of risky) {
      expect(isContainedUnknownExecutionEligible(config, gate(), result), category).toBe(false)
    }
  })

  it('rejects a plan with an outside filesystem requirement even when axes claim repo-local', () => {
    const result = withRequirement(
      containedUnknownResult(),
      filesystemRead('/outside-workspace/input'),
    )

    expect(
      isContainedUnknownExecutionEligible(configWithContainedExecution(), gate(), result),
    ).toBe(false)
  })

  it('rejects mixed local and outside filesystem requirements', () => {
    const result = withRequirements(containedUnknownResult(), [
      filesystemRead(path.join(repoRoot, 'local.txt')),
      filesystemWrite('/outside-workspace/output.txt'),
    ])

    expect(
      isContainedUnknownExecutionEligible(configWithContainedExecution(), gate(), result),
    ).toBe(false)
  })

  it('rejects a filesystem requirement that escapes the workspace through a symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-eligibility-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'belay-contained-outside-'))
    try {
      await mkdir(path.join(root, 'workspace'))
      await writeFile(path.join(outside, 'secret.txt'), 'secret')
      await symlink(outside, path.join(root, 'workspace', 'escape'))
      const escapedPath = path.join(root, 'workspace', 'escape', 'secret.txt')
      const result = withRequirement(containedUnknownResult(), filesystemRead(escapedPath))

      expect(
        isContainedUnknownExecutionEligible(
          configWithContainedExecution(),
          gate('shell', path.join(root, 'workspace')),
          result,
        ),
      ).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('fails closed when the gate repository identity cannot be resolved', () => {
    expect(
      isContainedUnknownExecutionEligible(
        configWithContainedExecution(),
        gate('shell', '/workspace/\0invalid'),
        containedUnknownResult(),
      ),
    ).toBe(false)
  })

  it('requires the contained opt-in, a shell gate, an unknown reason, and safe plan context', () => {
    const baseline = containedUnknownResult()
    const enabled = configWithContainedExecution()
    const shellGateDisabled = normalizeConfig({
      ...enabled,
      gates: { ...enabled.gates, shell: false },
    })
    const cases: Array<
      [string, ReturnType<typeof configWithContainedExecution>, 'shell' | 'tool', ClassifyResult]
    > = [
      ['contained execution disabled', configWithContainedExecution(false), 'shell', baseline],
      ['shell gate disabled', shellGateDisabled, 'shell', baseline],
      ['non-shell gate', enabled, 'tool', baseline],
      ['known-safe classification', enabled, 'shell', { ...baseline, reason: 'read_only' }],
      [
        'non-local classification',
        enabled,
        'shell',
        { ...baseline, axes: { ...baseline.axes, location: 'unknown' } },
      ],
      [
        'opaque plan',
        enabled,
        'shell',
        { ...baseline, effectPlan: { ...baseline.effectPlan, opacity: 'opaque' } },
      ],
      ['no process execution', enabled, 'shell', withoutProcessRequirement(baseline)],
    ]

    for (const [condition, config, kind, result] of cases) {
      expect(isContainedUnknownExecutionEligible(config, gate(kind), result), condition).toBe(false)
    }

    const recursive: ContainedUnknownResult = {
      ...baseline,
      effectPlan: { ...baseline.effectPlan, opacity: 'recursive' },
    }
    expect(isContainedUnknownExecutionEligible(enabled, gate(), recursive)).toBe(false)
    expect(
      isContainedUnknownExecutionEligible(enabled, gate(), safelyExpandedRecursive(recursive)),
    ).toBe(true)
  })

  it('uses only gate and EffectPlan architecture, never command or corpus authority', async () => {
    const source = await readFile(
      new URL('../core/contained-execution/eligibility.ts', import.meta.url),
      'utf8',
    )
    const sourceFile = ts.createSourceFile('eligibility.ts', source, ts.ScriptTarget.Latest, true)
    const imports = sourceFile.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        return []
      }
      return [statement.moduleSpecifier.text]
    })
    const forbiddenProperties = new Set([
      'command',
      'commandRedacted',
      'commandFingerprint',
      'corpus',
      'customAllowCommands',
      'customExternalCommands',
      'fingerprint',
      'inputFingerprint',
      'innerArgv',
      'normalizedCommand',
      'overrides',
      'segmentHead',
      'summary',
    ])
    const inspectedIdentity: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && forbiddenProperties.has(node.name.text)) {
        inspectedIdentity.push(node.name.text)
      }
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) &&
        forbiddenProperties.has(node.argumentExpression.text)
      ) {
        inspectedIdentity.push(node.argumentExpression.text)
      }
      if (ts.isBindingElement(node)) {
        const propertyName = node.propertyName
        const property =
          propertyName && ts.isIdentifier(propertyName)
            ? propertyName.text
            : ts.isIdentifier(node.name)
              ? node.name.text
              : null
        if (property && forbiddenProperties.has(property)) {
          inspectedIdentity.push(property)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    expect(imports.some(isCommandAuthorityDependency)).toBe(false)
    expect(inspectedIdentity).toEqual([])
  })
})

function isCommandAuthorityDependency(module: string): boolean {
  return (
    module.includes('/corpus/') ||
    module.includes('decoder') ||
    module.includes('override') ||
    module === '../custom-command-match.js' ||
    module === '../effect-ir/shell-lower.js' ||
    module === '../fingerprint.js' ||
    module === '../standing-allow.js' ||
    module === '../verdict/launcher-resolve.js'
  )
}

function containedUnknownResult(): ContainedUnknownResult {
  const requirements = [
    {
      tag: 'process.exec' as const,
      action: 'process.exec' as const,
      resource: {
        kind: 'executable' as const,
        command: 'fictional-runner',
        operation: 'spawn' as const,
      },
      evidence: { level: 'possible' as const, signals: [], basis: ['test'] },
      provenance: {},
    },
    {
      tag: 'indeterminate' as const,
      action: 'indeterminate' as const,
      resource: { kind: 'unknown' as const },
      evidence: { level: 'indeterminate' as const, signals: [], basis: ['test'] },
      provenance: {},
    },
  ] satisfies EffectRequirement[]
  const effectPlan: EffectPlan = {
    version: 1,
    root: {
      kind: 'exec',
      commandRedacted: 'fictional-runner verify',
      segmentHead: 'fictional-runner',
      requirements,
    },
    inputFingerprint: 'arbitrary-fingerprint',
    opacity: 'transparent',
    disposition: 'effects',
    completeness: 'partial',
    signals: [],
  }
  return {
    verdict: 'deny_pending_approval',
    reason: 'unknown_local_effect',
    fingerprint: 'arbitrary-fingerprint',
    assessment: {
      reversibility: 'irreversible',
      external: false,
      blastRadius: 'repo_local',
      confidence: 0.7,
      signals: [],
    },
    axes: {
      location: 'repo_local',
      opacity: 'transparent',
      effect: 'unknown',
      confidence: 'deterministic',
      would: 'ask',
      by: 'verdict',
      commandRedacted: 'fictional-runner verify',
      commandFingerprint: 'arbitrary-fingerprint',
      signals: [],
    },
    effectPlan,
  }
}

function withRequirement(
  result: ContainedUnknownResult,
  requirement: EffectRequirement,
): ContainedUnknownResult {
  const plan = result.effectPlan
  return {
    ...result,
    effectPlan: {
      ...plan,
      root: {
        kind: 'exec',
        commandRedacted: 'fictional-runner verify',
        segmentHead: 'fictional-runner',
        requirements: [...(plan.root.kind === 'exec' ? plan.root.requirements : []), requirement],
      },
    },
  }
}

function withRequirements(
  result: ContainedUnknownResult,
  requirements: readonly EffectRequirement[],
): ContainedUnknownResult {
  return requirements.reduce(withRequirement, result)
}

function withSignals(
  result: ContainedUnknownResult,
  signals: readonly string[],
): ContainedUnknownResult {
  return {
    ...result,
    assessment: { ...result.assessment, signals: [...signals] },
    axes: { ...result.axes, signals: [...signals] },
    effectPlan: { ...result.effectPlan, signals: [...signals] },
  }
}

function withoutProcessRequirement(result: ContainedUnknownResult): ContainedUnknownResult {
  const plan = result.effectPlan
  return {
    ...result,
    effectPlan: {
      ...plan,
      root: {
        kind: 'exec',
        commandRedacted: 'fictional-runner verify',
        segmentHead: 'fictional-runner',
        requirements:
          plan.root.kind === 'exec'
            ? plan.root.requirements.filter((requirement) => requirement.action !== 'process.exec')
            : [],
      },
    },
  }
}

function safelyExpandedRecursive(result: ContainedUnknownResult): ContainedUnknownResult {
  const plan = result.effectPlan
  if (plan.root.kind !== 'exec') {
    throw new Error('test fixture must have an exec root')
  }
  const [first, ...rest] = plan.root.requirements
  if (!first) {
    throw new Error('test fixture must contain a requirement')
  }
  return {
    ...result,
    effectPlan: {
      ...plan,
      root: {
        ...plan.root,
        requirements: [
          { ...first, provenance: { ...first.provenance, innerCommand: 'verify' } },
          ...rest,
        ],
      },
    },
  }
}

function networkRequirement(): EffectRequirement {
  return {
    tag: 'network.connect',
    action: 'network.connect',
    resource: { kind: 'network', host: 'example.test', mode: 'read', payload: 'none' },
    evidence: { level: 'certain', signals: [], basis: ['test'] },
    provenance: {},
  }
}

function secretRequirement(): EffectRequirement {
  return {
    tag: 'secret.read',
    action: 'secret.read',
    resource: { kind: 'path', path: `${repoRoot}/.env` },
    evidence: { level: 'certain', signals: [], basis: ['test'] },
    provenance: {},
  }
}

function controlPlaneRequirement(): EffectRequirement {
  return {
    tag: 'control_plane.write',
    action: 'control_plane.write',
    resource: { kind: 'path', path: `${repoRoot}/.belay/config.json` },
    evidence: { level: 'certain', signals: [], basis: ['test'] },
    provenance: {},
  }
}

function filesystemRead(targetPath: string): EffectRequirement {
  return {
    tag: 'fs.read',
    action: 'fs.read',
    resource: { kind: 'path', path: targetPath },
    evidence: { level: 'certain', signals: [], basis: ['test'] },
    provenance: {},
  }
}

function filesystemWrite(targetPath: string): EffectRequirement {
  return {
    tag: 'fs.write',
    action: 'fs.write',
    resource: { kind: 'path', path: targetPath },
    evidence: { level: 'certain', signals: [], basis: ['test'] },
    provenance: {},
  }
}
