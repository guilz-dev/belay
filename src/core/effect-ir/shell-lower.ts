import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { inspectGitResourceIdentity } from '../git-resource-identity.js'
import { isFdDuplication, isRedirectOperator, tokenizeShell } from '../shell-tokenizer.js'
import { decodeEgressEffects } from '../verdict/egress-classify.js'
import { decodeGitEffects } from '../verdict/git-classifier.js'
import { resolveLauncherRecipe } from '../verdict/launcher-resolve.js'
import {
  extractRecursiveScript,
  isCommandInspection,
  isDynamicRecursiveEvaluation,
  parseSegment,
  redactCommand,
  segmentOpacity,
  splitStructuralShellSegments,
  structuralSubstitutionInners,
} from '../verdict/parser.js'
import { joinEffectOpacity } from './normalize.js'
import {
  classifyPackageAcquisitionSpec,
  innerRecipeFromPeel,
  peelPackageExecArgv,
  resolveLocalBin,
} from './package-exec.js'
import {
  buildShellEffectPlan,
  type ShellEffectRequirement,
  type ShellEffectSegment,
} from './shell-build.js'
import type { EffectPlan, EffectProvenance } from './types.js'

const MAX_LOWER_DEPTH = 8
const ENV_PREFIX_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'])
const SECRET_PATH_PATTERN = /(?:^|[/\\])(?:\.env(?:\..*)?|credentials?|secrets?|id_rsa)(?:$|[/\\])/i
const CONTROL_PLANE_PATH_PATTERN =
  /^(?:\/etc(?:\/|$)|\/var\/run(?:\/|$)|.*(?:^|[/\\])\.(?:git|ssh|cursor|claude)(?:[/\\]|$))/

export interface LowerShellEffectPlanParams {
  command: string
  cwd: string
  repoRoot: string
  inputFingerprint: string
  env?: Readonly<Record<string, string | undefined>>
}

interface LowerContext extends LowerShellEffectPlanParams {
  depth: number
}

/**
 * Parse and lower a general shell command into the canonical Task 2 model.
 * This function only produces effects; it does not evaluate policy or return a
 * permission/verdict.
 */
export function lowerShellEffectPlan(params: LowerShellEffectPlanParams): EffectPlan {
  const context: LowerContext = { ...params, depth: 0 }
  const segments = lowerTopLevelSegments(params.command, context)
  return buildShellEffectPlan({
    inputFingerprint: params.inputFingerprint,
    segments,
    signals: pipeToShell(params.command) ? ['pipe_to_shell'] : [],
  })
}

function lowerTopLevelSegments(command: string, context: LowerContext): ShellEffectSegment[] {
  const commands = splitStructuralShellSegments(command)
  if (commands.length === 0 && command.trim()) {
    commands.push(command.trim())
  }
  const pipedToShell = pipeToShell(command)
  const lowered: ShellEffectSegment[] = []
  let cwd = context.cwd
  let cwdKnown = true
  let inferredEnv = { ...context.env }
  for (const segment of commands) {
    let result = lowerSegment(segment, {
      ...context,
      cwd,
      env: inferredEnv,
      command: segment,
      depth: context.depth,
      inputFingerprint: context.inputFingerprint,
      ...(pipedToShell && isShellHead(parseSegment(segment).head)
        ? { pipeToShellSegment: true }
        : {}),
    })
    if (!cwdKnown) {
      const requiresCwd = result.requirements.some(requiresKnownCwd)
      const requirements = [...result.requirements]
      if (requiresCwd) {
        requirements.push(
          requirement(
            'indeterminate',
            'indeterminate',
            { kind: 'unknown' },
            result.commandRedacted,
            ['shell.cwd_unknown'],
          ),
        )
      }
      result = {
        ...result,
        requirements,
        ...(requiresCwd
          ? {
              completeness: 'partial' as const,
              opacity: joinEffectOpacity(result.opacity, 'opaque'),
            }
          : {}),
        signals: [...new Set([...result.signals, 'shell.cwd_unknown'])],
      }
    }
    lowered.push(result)
    if (!inferredEnv.DATABASE_URL && startsLocalPostgresService(segment)) {
      inferredEnv = {
        ...inferredEnv,
        DATABASE_URL: 'postgresql://127.0.0.1:5432/local',
      }
    }
    const nextCwd = resolveCdTransition(segment, cwd)
    if (nextCwd) {
      cwd = nextCwd.cwd
      cwdKnown = nextCwd.known
    }
  }
  if (
    commands.length > 1 &&
    /[\r\n]/.test(command) &&
    lowered.some((segment) =>
      segment.requirements.some((entry) => entry.action === 'network.connect'),
    )
  ) {
    lowered.push(
      shellSegment(
        '[multiline network boundary]',
        'shell-boundary',
        [
          requirement(
            'indeterminate',
            'indeterminate',
            { kind: 'unknown' },
            '[multiline network boundary]',
            ['shell.multiline_network_boundary'],
          ),
        ],
        'opaque',
        new Set(['shell.multiline_network_boundary']),
      ),
    )
  }
  return lowered
}

function startsLocalPostgresService(command: string): boolean {
  const tokens = tokenizeShell(command)
  return (
    path.basename(tokens[0] ?? '') === 'docker' &&
    tokens[1] === 'compose' &&
    ['up', 'start', 'restart'].includes(tokens[2] ?? '') &&
    tokens.includes('postgres')
  )
}

function resolveCdTransition(
  command: string,
  currentCwd: string,
): { cwd: string; known: boolean } | null {
  const tokens = tokenizeShell(command)
  if (path.basename(tokens[0] ?? '') !== 'cd') {
    return null
  }
  const target = tokens[1] ?? '~'
  if (!target || target === '-' || target.includes('$') || target.includes('`')) {
    return { cwd: currentCwd, known: false }
  }
  return { cwd: resolvePathOperand(target, currentCwd), known: true }
}

function requiresKnownCwd(requirementValue: ShellEffectRequirement): boolean {
  if (
    requirementValue.action === 'fs.write' ||
    requirementValue.action === 'git.ref.write' ||
    requirementValue.action === 'control_plane.write'
  ) {
    return true
  }
  return (
    requirementValue.action === 'process.exec' &&
    requirementValue.resource.kind === 'executable' &&
    requirementValue.resource.operation === 'spawn'
  )
}

function joinNestedOpacity(
  outer: EffectPlan['opacity'],
  nested: ShellEffectSegment,
): EffectPlan['opacity'] {
  const nestedOpacity =
    nested.completeness === 'partial' && nested.opacity === 'transparent'
      ? 'recursive'
      : nested.opacity
  return joinEffectOpacity(outer, nestedOpacity)
}

function lowerSegment(
  command: string,
  context: LowerContext & { pipeToShellSegment?: boolean },
): ShellEffectSegment {
  const commandRedacted = redactCommand(command)
  const rawTokens = tokenizeShell(command)
  const environment = extractEnvironment(rawTokens, context.env)
  const env = environment.env
  const parsed = parseSegment(command)
  const tokens = stripRedirects(environment.commandTokens ?? parsed.tokens).map((token) =>
    expandKnownVariables(token, env),
  )
  const head = path.basename(tokens[0] ?? parsed.head)
  let opacity = segmentOpacity(command)
  const signals = new Set<string>()
  const requirements: ShellEffectRequirement[] = []

  addRedirectEffects(requirements, rawTokens, env, context, commandRedacted)
  addSubstitutionEffects(requirements, command, context, commandRedacted, signals)
  if (environment.malformed) {
    requirements.push(
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
        'shell.env_wrapper_incomplete',
      ]),
    )
    opacity = joinEffectOpacity(opacity, 'opaque')
  }
  if (parsed.encounteredXargs) {
    requirements.push(
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
        'shell.xargs_stdin_dynamic',
      ]),
    )
    signals.add('shell.xargs_stdin_dynamic')
    opacity = joinEffectOpacity(opacity, 'opaque')
  }

  if (context.depth >= MAX_LOWER_DEPTH) {
    requirements.push(
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
        'shell.lower_depth_exceeded',
      ]),
    )
    return shellSegment(
      commandRedacted,
      head,
      requirements,
      joinEffectOpacity(opacity, 'opaque'),
      signals,
    )
  }

  const packageExec = peelPackageExecArgv(tokens)
  if (packageExec) {
    requirements.push(
      ...decodePackageExec(packageExec, context.cwd, context.repoRoot, commandRedacted),
    )
    for (const signal of packageExec.signals) {
      signals.add(signal)
    }
    if (packageExec.opaque) {
      opacity = joinEffectOpacity(opacity, 'opaque')
    }
    const innerRecipe = packageExecInnerIsMetadata(packageExec)
      ? null
      : innerRecipeFromPeel(packageExec)
    if (innerRecipe) {
      const nested = lowerTopLevelSegments(innerRecipe, {
        ...context,
        command: innerRecipe,
        env,
        depth: context.depth + 1,
      })
      for (const nestedSegment of nested) {
        requirements.push(
          ...nestedSegment.requirements.map((entry) =>
            withInnerProvenance(entry, innerRecipe, packageExec.launcher, commandRedacted),
          ),
        )
        for (const signal of nestedSegment.signals) {
          signals.add(signal)
        }
        opacity = joinNestedOpacity(opacity, nestedSegment)
      }
    }
    return shellSegment(commandRedacted, head, requirements, opacity, signals)
  }

  const recursiveScript = extractRecursiveScript(tokens)
  if (recursiveScript && opacity !== 'opaque' && opacity !== 'unparseable') {
    const dynamicEvaluation = isDynamicRecursiveEvaluation(tokens)
    requirements.push(
      processRequirement(head || 'sh', 'spawn', commandRedacted, [
        'shell.recursive_wrapper',
        ...(dynamicEvaluation ? ['dynamic_shell_evaluation'] : []),
      ]),
    )
    const nested = lowerTopLevelSegments(recursiveScript, {
      ...context,
      command: recursiveScript,
      env,
      depth: context.depth + 1,
    })
    for (const nestedSegment of nested) {
      requirements.push(
        ...nestedSegment.requirements.map((entry) =>
          withInnerProvenance(entry, recursiveScript, head, commandRedacted),
        ),
      )
      for (const signal of nestedSegment.signals) {
        signals.add(signal)
      }
    }
    signals.add('shell.recursive_wrapper')
    if (dynamicEvaluation) {
      signals.add('dynamic_shell_evaluation')
    }
    return shellSegment(commandRedacted, head, requirements, 'recursive', signals)
  }

  const launcher = resolveLauncherRecipe({
    tokens,
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    depth: context.depth,
  })
  if (launcher) {
    signals.add(`launcher.${launcher.reason}`)
    requirements.push(
      requirement(
        'process.exec',
        'process.exec',
        { kind: 'executable', command: head, operation: 'spawn' },
        commandRedacted,
        ['launcher.invoke'],
      ),
    )
    for (const recipe of launcher.recipes) {
      const nested = lowerTopLevelSegments(recipe, {
        ...context,
        command: recipe,
        env,
        depth: context.depth + 1,
      })
      for (const nestedSegment of nested) {
        requirements.push(
          ...nestedSegment.requirements.map((entry) =>
            withInnerProvenance(entry, recipe, head, commandRedacted),
          ),
        )
        for (const signal of nestedSegment.signals) {
          signals.add(signal)
        }
        opacity = joinNestedOpacity(opacity, nestedSegment)
      }
    }
    if (launcher.opaque || launcher.recipes.length === 0) {
      requirements.push(
        requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
          `launcher.${launcher.reason}`,
        ]),
      )
      opacity = joinEffectOpacity(opacity, 'opaque')
    }
    return shellSegment(commandRedacted, head, requirements, opacity, signals)
  }

  const egress = decodeEgressEffects({
    tokens,
    cwd: context.cwd,
    segment: commandRedacted,
  })
  if (egress) {
    requirements.push(...egress)
    for (const signal of egress.flatMap((entry) => entry.evidence.signals)) {
      signals.add(signal)
    }
  } else {
    const git = decodeGitEffects({
      tokens,
      cwd: context.cwd,
      repoRoot: context.repoRoot,
      segment: commandRedacted,
    })
    if (git) {
      requirements.push(...git)
      for (const signal of git.flatMap((entry) => entry.evidence.signals)) {
        signals.add(signal)
      }
    } else {
      requirements.push(
        ...decodeProcessOrFilesystem({
          tokens,
          head,
          env,
          cwd: context.cwd,
          repoRoot: context.repoRoot,
          segment: commandRedacted,
        }),
      )
    }
  }

  const environmentSignals = effectChangingEnvironmentSignals(head, env, environment.changedNames)
  if (environmentSignals.length > 0) {
    requirements.push(
      requirement(
        'indeterminate',
        'indeterminate',
        { kind: 'unknown' },
        commandRedacted,
        environmentSignals,
      ),
    )
    opacity = joinEffectOpacity(opacity, 'opaque')
    for (const signal of environmentSignals) {
      signals.add(signal)
    }
  }

  if (context.pipeToShellSegment) {
    signals.add('pipe_to_shell')
    ensureRequirement(
      requirements,
      requirement(
        'process.exec',
        'process.exec',
        { kind: 'executable', command: head || 'sh', operation: 'spawn' },
        commandRedacted,
        ['pipe_to_shell'],
      ),
    )
    ensureRequirement(
      requirements,
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
        'pipe_to_shell',
      ]),
    )
    opacity = joinEffectOpacity(opacity, 'opaque')
  }

  if (opacity === 'unparseable' || opacity === 'opaque') {
    ensureRequirement(
      requirements,
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
        `shell.${opacity}`,
      ]),
    )
  }
  return shellSegment(commandRedacted, head, requirements, opacity, signals)
}

function decodePackageExec(
  peel: NonNullable<ReturnType<typeof peelPackageExecArgv>>,
  cwd: string,
  repoRoot: string,
  segment: string,
): ShellEffectRequirement[] {
  if (peel.opaque) {
    return [
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        peel.reason,
        ...peel.signals,
      ]),
    ]
  }
  if (peel.reason === 'npx_wrapper_readonly') {
    return []
  }

  const binHead = peel.innerTokens[0] ?? ''
  const metadataOnly = packageExecInnerIsMetadata(peel)
  const local = !peel.forceAcquire ? resolveLocalBin(binHead, cwd, repoRoot) : null
  if (local) {
    return metadataOnly
      ? [
          requirement(
            'process.exec',
            'process.exec',
            { kind: 'executable', command: local.path, operation: 'inspect' },
            segment,
            ['package_exec.delegate', 'package_exec.local_bin_resolved'],
          ),
        ]
      : []
  }

  const networkResources = peel.acquisitionSpecs
    .map((spec) => classifyPackageAcquisitionSpec(spec))
    .filter((source) => source.kind !== 'local')
    .map((source) =>
      source.kind === 'registry'
        ? {
            kind: 'network' as const,
            host: 'registry.npmjs.org',
            protocol: 'registry',
            mode: 'read' as const,
            payload: 'none' as const,
          }
        : {
            kind: 'network' as const,
            host: source.host,
            ...(source.port ? { port: source.port } : {}),
            protocol: source.protocol,
            mode: 'read' as const,
            payload: 'none' as const,
          },
    )
  if (networkResources.length === 0) {
    networkResources.push({
      kind: 'network',
      host: 'registry.npmjs.org',
      protocol: 'registry',
      mode: 'read',
      payload: 'none',
    })
  }
  return [
    ...networkResources.map((resource) =>
      requirement('network.acquire', 'network.connect', resource, segment, [
        'package_acquire_possible',
      ]),
    ),
    requirement(
      'fs.write',
      'fs.write',
      { kind: 'package-cache', manager: peel.launcher === 'pnpm' ? 'pnpm' : 'npm' },
      segment,
      ['package_cache_write'],
    ),
    ...(metadataOnly
      ? [
          requirement(
            'process.exec',
            'process.exec',
            { kind: 'executable', command: binHead || peel.launcher, operation: 'inspect' },
            segment,
            ['package_exec.delegate'],
          ),
        ]
      : []),
  ]
}

function packageExecInnerIsMetadata(
  peel: NonNullable<ReturnType<typeof peelPackageExecArgv>>,
): boolean {
  const args = peel.innerTokens.slice(1)
  return (
    args.length > 0 && args.every((arg) => ['--help', '--version', '-V', '-h', '-v'].includes(arg))
  )
}

const METADATA_ONLY_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h'])

function isMetadataOnlyArgv(argv: string[]): boolean {
  return argv.length > 0 && argv.every((token) => METADATA_ONLY_FLAGS.has(token))
}

function executableBaseName(head: string): string {
  return path.basename(head)
}

const RAILS_READ_ONLY_SUBCOMMANDS = new Set(['routes', 'middleware', 'stats', 'about', 'version'])

function railsReadOnlySubcommand(args: string[]): boolean {
  const subcommand = args[0]
  if (!subcommand || subcommand.startsWith('-')) {
    return false
  }
  return RAILS_READ_ONLY_SUBCOMMANDS.has(subcommand)
}

function decodeRuntimeMetadataProcess(
  head: string,
  args: string[],
  segment: string,
): ShellEffectRequirement[] | null {
  if (head === 'bundle') {
    if (args.length === 1 && isMetadataOnlyArgv(args)) {
      return [processRequirement(head, 'inspect', segment, ['process.inspect.runtime_metadata'])]
    }
    if (args[0] === 'exec' && args.length >= 2) {
      const innerHead = args[1] ?? ''
      const innerArgs = args.slice(2)
      const innerBase = executableBaseName(innerHead)
      if ((innerBase === 'rails' || innerBase === 'rake') && railsReadOnlySubcommand(innerArgs)) {
        return [
          processRequirement(innerHead, 'inspect', segment, ['process.inspect.rails_read_only']),
        ]
      }
      if (isMetadataOnlyArgv(innerArgs)) {
        return [
          processRequirement(innerHead, 'inspect', segment, [
            'process.inspect.bundle_exec_metadata',
          ]),
        ]
      }
    }
    return null
  }

  if ((head === 'ruby' || head === 'yarn') && args.length >= 1 && isMetadataOnlyArgv(args)) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.runtime_metadata'])]
  }

  if (head === 'make' && args.includes('-n')) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.make_dry_run'])]
  }

  const base = executableBaseName(head)
  if ((base === 'rails' || base === 'rake') && railsReadOnlySubcommand(args)) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.rails_read_only'])]
  }

  return null
}

function decodeProcessOrFilesystem(params: {
  tokens: string[]
  head: string
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  repoRoot: string
  segment: string
}): ShellEffectRequirement[] {
  const { tokens, head, env, cwd, repoRoot, segment } = params
  const args = tokens.slice(1)

  if (isCommandInspection(tokens)) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.command_lookup'])]
  }
  if (head === 'lsof') {
    return validLsof(args)
      ? [processRequirement(head, 'inspect', segment, ['process.inspect.lsof'])]
      : unsupportedProcess(head, segment, 'process.lsof_grammar_incomplete')
  }
  if (head === 'ps') {
    return validPs(args)
      ? [processRequirement(head, 'inspect', segment, ['process.inspect.ps'])]
      : unsupportedProcess(head, segment, 'process.ps_grammar_incomplete')
  }
  if (head === 'test' || head === '[') {
    return validFilesystemTest(head, args)
      ? [processRequirement(head, 'inspect', segment, ['process.inspect.filesystem_test'])]
      : unsupportedProcess(head, segment, 'process.filesystem_test_grammar_incomplete')
  }
  if (head === 'docker') {
    if (args[0] === 'info') {
      return validDockerInfo(args.slice(1))
        ? [processRequirement(head, 'inspect', segment, ['process.inspect.docker_info'])]
        : unsupportedProcess(head, segment, 'process.docker_info_grammar_incomplete')
    }
    if (
      args[0] === 'compose' &&
      ['up', 'down', 'start', 'stop', 'restart', 'create', 'rm'].includes(args[1] ?? '')
    ) {
      return [processRequirement(head, 'spawn', segment, ['service.local_mutation'])]
    }
    if (
      args[0] === 'push' ||
      (args[0] === 'build' && args.includes('--push')) ||
      (args[0] === 'buildx' &&
        args[1] === 'build' &&
        (args.includes('--push') ||
          args.some(
            (arg) => arg.startsWith('--output=type=registry') || arg.startsWith('-o=type=registry'),
          )))
    ) {
      return [
        processRequirement(head, 'spawn', segment, ['tier0_external', 'docker.remote_mutation']),
        requirement(
          'network.connect',
          'network.connect',
          {
            kind: 'network',
            host: 'registry',
            protocol: 'container-registry',
            mode: 'mutate',
            payload: 'present',
          },
          segment,
          ['tier0_external', 'docker.remote_mutation'],
        ),
      ]
    }
    if (
      args[0] === 'run' ||
      args[0] === 'create' ||
      args[0] === 'pull' ||
      args[0] === 'build' ||
      (args[0] === 'buildx' && args[1] === 'build')
    ) {
      return [
        processRequirement(head, 'spawn', segment, ['process.docker_spawn']),
        requirement(
          'network.acquire',
          'network.connect',
          {
            kind: 'network',
            host: 'unknown',
            protocol: 'container-registry',
            mode: 'ambiguous',
            payload: 'none',
          },
          segment,
          ['docker.image_acquisition_possible'],
        ),
      ]
    }
    return [processRequirement(head, 'spawn', segment, ['process.docker_spawn'])]
  }
  if (isShellHead(head)) {
    const syntax = bashSyntaxTarget(args)
    if (syntax) {
      return [
        processRequirement(head, 'inspect', segment, ['process.inspect.shell_syntax']),
        requirement(
          'fs.read',
          'fs.read',
          { kind: 'path', path: path.resolve(cwd, syntax) },
          segment,
          ['shell.syntax_source_read'],
        ),
      ]
    }
    return unsupportedProcess(head, segment, 'process.shell_grammar_incomplete')
  }
  if (head === 'prisma') {
    return decodePrisma(args, env, repoRoot, segment)
  }
  const runtimeMetadata = decodeRuntimeMetadataProcess(head, args, segment)
  if (runtimeMetadata) {
    return runtimeMetadata
  }
  if ((head === 'npm' || head === 'pnpm') && args.length === 1 && isMetadataOnlyArgv(args)) {
    return [processRequirement(head, 'inspect', segment, ['process.inspect.package_manager'])]
  }
  if (head === 'belay') {
    return decodeBelay(args, repoRoot, segment)
  }
  if (head === 'tsc') {
    return decodeTsc(args, cwd, segment)
  }
  if (head === 'go') {
    return decodeGo(args, segment)
  }
  if (head === 'rsync') {
    return decodeRsync(args, cwd, segment)
  }
  if (head === 'sed') {
    return decodeSed(args, cwd, segment)
  }
  if (head === 'node') {
    return decodeNode(args, cwd, segment)
  }
  if (head === 'vite' || head === 'vite-node') {
    return [processRequirement(head, 'spawn', segment, ['process.local_dev_spawn'])]
  }
  if (
    ((head === 'npm' || head === 'pnpm') && args[0] === 'publish') ||
    (head === 'terraform' && args[0] === 'apply')
  ) {
    return [
      processRequirement(head, 'spawn', segment, ['tier0_external']),
      requirement(
        'network.connect',
        'network.connect',
        {
          kind: 'network',
          host: 'control-plane',
          protocol: head,
          mode: 'mutate',
          payload: 'present',
        },
        segment,
        ['tier0_external'],
      ),
    ]
  }
  if (head === 'cd') {
    return []
  }
  if (head === 'cp' || head === 'mv') {
    return decodeCopyMove(head, args, cwd, segment)
  }
  if (head === 'rm') {
    return decodeRm(args, cwd, repoRoot, segment)
  }
  if (head === 'vitest' || head === 'eslint' || head === 'biome' || head === 'belay') {
    return [processRequirement(head, 'spawn', segment, ['process.known_local_spawn'])]
  }
  if (head === 'pwd' || head === 'which' || head === 'whoami') {
    return [processRequirement(head, 'inspect', segment, ['process.pure_inspection'])]
  }

  const readOperands = filesystemReadOperands(head, args)
  if (readOperands !== null) {
    const lowered = [processRequirement(head, 'inspect', segment, ['process.filesystem_inspect'])]
    for (const operand of readOperands) {
      const resolved = resolvePathOperand(operand, cwd)
      lowered.push(
        requirement('fs.read', 'fs.read', { kind: 'path', path: resolved }, segment, [
          'filesystem.read',
        ]),
      )
      addSecretRead(lowered, resolved, segment)
    }
    return lowered
  }

  const writeOperands = filesystemWriteOperands(head, args)
  if (writeOperands !== null) {
    const lowered = [processRequirement(head, 'spawn', segment, ['process.filesystem_mutation'])]
    for (const operand of writeOperands) {
      addWriteEffects(lowered, resolvePathOperand(operand, cwd), segment, ['filesystem.write'])
    }
    return lowered
  }

  if (head === 'printf' || head === 'echo' || head === 'true' || head === 'false' || head === ':') {
    return []
  }
  if (!head) {
    return [
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'shell.segment_empty',
      ]),
    ]
  }
  return unsupportedProcess(head, segment, 'process.grammar_unknown')
}

function decodeBelay(args: string[], repoRoot: string, segment: string): ShellEffectRequirement[] {
  const [section, operation, key] = args
  const judgeCommand =
    section === 'judge' &&
    operation !== undefined &&
    ['consent', 'list', 'status', 'test', 'use'].includes(operation)
  const configRead =
    section === 'config' &&
    (operation === undefined ||
      operation === 'list' ||
      (operation === 'get' && key?.startsWith('judge.')))
  const configJudgeMutation =
    section === 'config' &&
    ((['set', 'unset'].includes(operation ?? '') && key?.startsWith('judge.')) ||
      (operation === 'credential' && key === 'mode'))
  if (judgeCommand || configRead || configJudgeMutation) {
    return [
      processRequirement('belay', 'inspect', segment, [
        'belay_control_plane_command',
        configJudgeMutation ? 'belay.config_judge_mutation' : 'belay.config_read',
      ]),
    ]
  }
  if (section === 'config' && ['set', 'unset', 'credential'].includes(operation ?? '')) {
    return [
      requirement(
        'control_plane.write',
        'control_plane.write',
        { kind: 'path', path: path.join(repoRoot, '.belay-control-plane') },
        segment,
        ['belay.config_non_judge_mutation'],
      ),
    ]
  }
  return [processRequirement('belay', 'spawn', segment, ['process.known_local_spawn'])]
}

function decodeTsc(args: string[], cwd: string, segment: string): ShellEffectRequirement[] {
  const inspect =
    args.length > 0 && args.every((arg) => ['--help', '--version', '-h', '-v'].includes(arg))
  const requirements = [
    processRequirement('tsc', inspect ? 'inspect' : 'spawn', segment, [
      inspect ? 'process.inspect.tsc_metadata' : 'process.known_local_spawn',
    ]),
  ]
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    const inline = arg.match(/^--(?:outDir|outFile)=(.+)$/)?.[1]
    const separate =
      (arg === '--outDir' || arg === '--outFile') && args[index + 1] ? args[index + 1] : null
    const output = inline ?? separate
    if (!output) {
      continue
    }
    addWriteEffects(requirements, resolvePathOperand(output, cwd), segment, ['tsc.output'])
    if (separate) {
      index += 1
    }
  }
  return requirements
}

function decodeCopyMove(
  head: 'cp' | 'mv',
  args: string[],
  cwd: string,
  segment: string,
): ShellEffectRequirement[] {
  const requirements = [processRequirement(head, 'spawn', segment, ['process.filesystem_mutation'])]
  const operands: string[] = []
  let targetDirectory: string | null = null
  let recursive = false
  let incomplete = false
  let optionsEnded = false
  const neutralFlags = new Set([
    '-f',
    '-i',
    '-n',
    '-p',
    '-v',
    '--force',
    '--interactive',
    '--no-clobber',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && (arg === '-r' || arg === '-R' || arg === '--recursive')) {
      recursive = true
      continue
    }
    if (!optionsEnded && (arg === '-t' || arg === '--target-directory')) {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) {
        incomplete = true
      } else {
        targetDirectory = value
        index += 1
      }
      continue
    }
    if (!optionsEnded && arg.startsWith('--target-directory=')) {
      targetDirectory = arg.slice('--target-directory='.length) || null
      incomplete ||= !targetDirectory
      continue
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (!neutralFlags.has(arg)) {
        incomplete = true
      }
      continue
    }
    operands.push(arg)
  }

  const sources = targetDirectory ? operands : operands.slice(0, -1)
  const destination = targetDirectory ?? (operands.length >= 2 ? (operands.at(-1) ?? null) : null)
  if (sources.length === 0 || !destination) {
    incomplete = true
  }
  for (const source of sources) {
    const resolved = resolvePathOperand(source, cwd)
    requirements.push(
      requirement('fs.read', 'fs.read', { kind: 'path', path: resolved }, segment, [
        `${head}.source_read`,
      ]),
    )
    addSecretRead(requirements, resolved, segment)
    if (head === 'mv') {
      addWriteEffects(requirements, resolved, segment, ['mv.source_remove'])
    }
  }
  if (destination) {
    addWriteEffects(requirements, resolvePathOperand(destination, cwd), segment, [
      `${head}.destination_write`,
    ])
  }
  if (recursive || incomplete) {
    requirements.push(
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        recursive ? `${head}.recursive_source` : `${head}.grammar_incomplete`,
      ]),
    )
  }
  return requirements
}

function decodeRm(
  args: string[],
  cwd: string,
  repoRoot: string,
  segment: string,
): ShellEffectRequirement[] {
  const requirements = [processRequirement('rm', 'spawn', segment, ['process.filesystem_mutation'])]
  const recursive = args.some(
    (arg) => arg === '-r' || arg === '-R' || arg === '--recursive' || /^-[^-]*[rR]/.test(arg),
  )
  const operands = args.filter((arg) => arg && !arg.startsWith('-'))
  if (operands.length === 0) {
    return [
      ...requirements,
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'rm.operand_missing',
      ]),
    ]
  }
  const identity = inspectGitResourceIdentity(repoRoot)
  for (const operand of operands) {
    const resolved = resolvePathOperand(operand, cwd)
    addWriteEffects(requirements, resolved, segment, ['filesystem.write', 'rm.remove'])
    const finalOperandIsSymlink = isSymbolicLink(resolved)
    const canonicalResolved = canonicalRmOperand(resolved, finalOperandIsSymlink)
    const targetIdentity =
      recursive && !finalOperandIsSymlink
        ? inspectGitResourceIdentity(resolved)
        : { status: 'absent' as const }
    const sameIdentityTargetRoot =
      identity.status === 'resolved' &&
      targetIdentity.status === 'resolved' &&
      identity.identity.commonDir === targetIdentity.identity.commonDir &&
      pathContains(canonicalResolved, targetIdentity.identity.repositoryRoot)
    if (
      recursive &&
      identity.status === 'resolved' &&
      (sameIdentityTargetRoot ||
        [
          repoRoot,
          identity.identity.repositoryRoot,
          identity.identity.gitDir,
          identity.identity.commonDir,
          identity.identity.gitEntryPath,
        ].some((metadataPath) => pathContains(canonicalResolved, metadataPath)))
    ) {
      const gitEntryPath =
        targetIdentity.status === 'resolved'
          ? targetIdentity.identity.gitEntryPath
          : identity.identity.gitEntryPath
      requirements.push(
        requirement(
          'control_plane.write',
          'control_plane.write',
          { kind: 'path', path: gitEntryPath },
          segment,
          ['rm.recursive_git_boundary', 'tier1_catastrophic'],
        ),
      )
    }
  }
  return requirements
}

function canonicalRmOperand(targetPath: string, finalOperandIsSymlink: boolean): string {
  try {
    if (finalOperandIsSymlink) {
      return path.join(realpathSync.native(path.dirname(targetPath)), path.basename(targetPath))
    }
    return realpathSync.native(targetPath)
  } catch {
    return path.resolve(targetPath)
  }
}

function isSymbolicLink(targetPath: string): boolean {
  try {
    return lstatSync(targetPath).isSymbolicLink()
  } catch {
    return false
  }
}

function pathContains(ancestor: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(ancestor), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function decodeGo(args: string[], segment: string): ShellEffectRequirement[] {
  if (['test', 'list', 'vet'].includes(args[0] ?? '')) {
    return [processRequirement('go', 'spawn', segment, ['process.go_local_spawn'])]
  }
  if (args[0] === 'install' || (args[0] === 'mod' && args[1] === 'download')) {
    return [
      processRequirement('go', 'spawn', segment, ['process.go_acquire']),
      requirement(
        'network.acquire',
        'network.connect',
        {
          kind: 'network',
          host: 'unknown',
          protocol: 'go-module',
          mode: 'ambiguous',
          payload: 'none',
        },
        segment,
        ['go.network_acquisition_possible'],
      ),
    ]
  }
  return unsupportedProcess('go', segment, 'process.go_grammar_incomplete')
}

function decodeRsync(args: string[], cwd: string, segment: string): ShellEffectRequirement[] {
  const destructive = args.some(
    (arg) => arg === '--delete' || arg === '--del' || arg.startsWith('--delete-'),
  )
  if (destructive) {
    return [
      processRequirement('rsync', 'spawn', segment, ['rsync_destructive']),
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'rsync_destructive',
      ]),
    ]
  }
  const allowedFlags = new Set([
    '-a',
    '-r',
    '-v',
    '-z',
    '--archive',
    '--delay-updates',
    '--recursive',
    '--verbose',
  ])
  if (args.some((arg) => arg.startsWith('-') && !allowedFlags.has(arg))) {
    return unsupportedProcess('rsync', segment, 'process.rsync_grammar_incomplete')
  }
  const operands = args.filter((arg) => !arg.startsWith('-'))
  if (operands.length < 2) {
    return unsupportedProcess('rsync', segment, 'process.rsync_operands_incomplete')
  }
  if (operands.some(isRemoteRsyncOperand)) {
    return [
      processRequirement('rsync', 'spawn', segment, ['rsync.remote']),
      requirement(
        'network.connect',
        'network.connect',
        {
          kind: 'network',
          host: 'remote',
          protocol: 'rsync',
          mode: 'mutate',
          payload: 'present',
        },
        segment,
        ['rsync.remote'],
      ),
    ]
  }
  const destination = operands.at(-1) ?? ''
  return [
    processRequirement('rsync', 'spawn', segment, ['process.rsync_local']),
    ...operands
      .slice(0, -1)
      .map((operand) =>
        requirement(
          'fs.read',
          'fs.read',
          { kind: 'path', path: resolvePathOperand(operand, cwd) },
          segment,
          ['rsync.local_source'],
        ),
      ),
    requirement(
      'fs.write',
      'fs.write',
      { kind: 'path', path: resolvePathOperand(destination, cwd) },
      segment,
      ['rsync.local_destination'],
    ),
  ]
}

function isRemoteRsyncOperand(operand: string): boolean {
  return (
    /^rsync:\/\//i.test(operand) ||
    /^[^/:\s]+::/.test(operand) ||
    /^(?:[^@/:\s]+@)?[^/:\s]+:/.test(operand)
  )
}

function decodeSed(args: string[], cwd: string, segment: string): ShellEffectRequirement[] {
  let inline = false
  let scriptConsumed = false
  const files: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
      continue
    }
    if (arg === '-i' || arg === '--in-place' || arg.startsWith('-i')) {
      inline = true
      continue
    }
    if (arg === '-e' || arg === '--expression') {
      if (!args[index + 1]) {
        return unsupportedProcess('sed', segment, 'process.sed_expression_missing')
      }
      scriptConsumed = true
      index += 1
      continue
    }
    if (arg.startsWith('--expression=')) {
      scriptConsumed = true
      continue
    }
    if (arg.startsWith('-')) {
      return unsupportedProcess('sed', segment, 'process.sed_grammar_incomplete')
    }
    if (!scriptConsumed) {
      scriptConsumed = true
      continue
    }
    files.push(arg)
  }
  const operation = inline ? 'spawn' : 'inspect'
  const lowered = [processRequirement('sed', operation, segment, ['process.sed'])]
  for (const file of files) {
    lowered.push(
      requirement(
        inline ? 'fs.write' : 'fs.read',
        inline ? 'fs.write' : 'fs.read',
        { kind: 'path', path: resolvePathOperand(file, cwd) },
        segment,
        [inline ? 'sed.in_place_write' : 'sed.file_read'],
      ),
    )
  }
  return lowered
}

function decodeNode(args: string[], cwd: string, segment: string): ShellEffectRequirement[] {
  if (args.length > 0 && args.every((arg) => ['--help', '--version', '-h', '-v'].includes(arg))) {
    return [processRequirement('node', 'inspect', segment, ['process.inspect.node_metadata'])]
  }
  if ((args[0] === '--check' || args[0] === '-c') && args.length === 2 && args[1]) {
    return [
      processRequirement('node', 'inspect', segment, ['process.inspect.node_syntax']),
      requirement(
        'fs.read',
        'fs.read',
        { kind: 'path', path: resolvePathOperand(args[1], cwd) },
        segment,
        ['node.syntax_source_read'],
      ),
    ]
  }
  return unsupportedProcess('node', segment, 'process.node_grammar_incomplete')
}

function decodePrisma(
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
  segment: string,
): ShellEffectRequirement[] {
  const processEffect = processRequirement('prisma', 'spawn', segment, ['process.prisma'])
  if (args[0] === 'generate') {
    return [
      processEffect,
      requirement('fs.write', 'fs.write', { kind: 'path', path: repoRoot }, segment, [
        'prisma.generate.repo_local',
      ]),
    ]
  }
  const databaseMutation =
    args[0] === 'migrate' || (args[0] === 'db' && args[1] === 'seed') || args[0] === 'seed'
  if (!databaseMutation) {
    return [
      processEffect,
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'prisma.grammar_incomplete',
      ]),
    ]
  }

  const endpoint = databaseEndpoint(env.DATABASE_URL)
  if (!endpoint) {
    return [
      processEffect,
      requirement(
        'network.connect',
        'network.connect',
        {
          kind: 'network',
          host: 'unknown',
          protocol: 'database',
          mode: 'ambiguous',
          payload: 'present',
        },
        segment,
        ['prisma.database_endpoint_unknown'],
      ),
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
        'prisma.database_endpoint_unknown',
      ]),
    ]
  }
  const network = requirement(
    'network.connect',
    'network.connect',
    {
      kind: 'network',
      ...endpoint,
      mode: 'mutate',
      payload: 'present',
    },
    segment,
    [LOOPBACK_HOSTS.has(endpoint.host) ? 'prisma.database_local' : 'prisma.database_remote'],
  )
  if (LOOPBACK_HOSTS.has(endpoint.host)) {
    return [processEffect, network]
  }
  return [
    processEffect,
    network,
    requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
      'prisma.remote_database_mutation',
    ]),
  ]
}

function addRedirectEffects(
  requirements: ShellEffectRequirement[],
  tokens: string[],
  env: Readonly<Record<string, string | undefined>>,
  context: LowerContext,
  segment: string,
): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const operator = tokens[index] ?? ''
    if (!isRedirectOperator(operator) || isFdDuplication(operator)) {
      continue
    }
    const rawTarget = tokens[index + 1]
    if (!rawTarget) {
      requirements.push(
        requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
          'shell.redirect_target_missing',
        ]),
      )
      continue
    }
    if (operator.includes('<<')) {
      requirements.push(
        requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
          'shell.heredoc_opaque',
        ]),
      )
      index += 1
      continue
    }
    const target = expandKnownVariables(rawTarget, env)
    const resolved = resolvePathOperand(target, context.cwd)
    if (resolved === '/dev/null') {
      index += 1
      continue
    }
    if (operator.includes('<')) {
      requirements.push(
        requirement('fs.read', 'fs.read', { kind: 'path', path: resolved }, segment, [
          'shell.input_redirect',
        ]),
      )
      addSecretRead(requirements, resolved, segment)
    }
    if (operator.includes('>')) {
      addWriteEffects(requirements, resolved, segment, ['shell.output_redirect'])
    }
    index += 1
  }
}

function addSubstitutionEffects(
  requirements: ShellEffectRequirement[],
  command: string,
  context: LowerContext,
  segment: string,
  signals: Set<string>,
): void {
  const inners = structuralSubstitutionInners(command)
  for (const inner of inners) {
    signals.add('command_substitution')
    if (context.depth >= MAX_LOWER_DEPTH) {
      requirements.push(
        requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [
          'shell.substitution_depth_exceeded',
        ]),
      )
      continue
    }
    const nestedSegments = lowerTopLevelSegments(inner, {
      ...context,
      command: inner,
      depth: context.depth + 1,
    })
    for (const nested of nestedSegments) {
      requirements.push(
        ...nested.requirements.map((entry) => {
          const outerProvenance: EffectProvenance = {
            segment,
            innerCommand: inner,
          }
          const provenance: EffectProvenance = {
            ...entry.provenance,
            segment,
            innerCommand: entry.provenance.innerCommand ?? inner,
          }
          return withProvenances(entry, provenance, outerProvenance)
        }),
      )
    }
  }
}

interface EnvironmentExtraction {
  env: Readonly<Record<string, string | undefined>>
  commandTokens?: string[]
  malformed: boolean
  changedNames: ReadonlySet<string>
}

function extractEnvironment(
  tokens: string[],
  inherited: Readonly<Record<string, string | undefined>> | undefined,
): EnvironmentExtraction {
  const env: Record<string, string | undefined> = { ...inherited }
  const changedNames = new Set<string>()
  if (tokens[0] === 'env') {
    let index = 1
    let malformed = false
    while (index < tokens.length) {
      const option = tokens[index] ?? ''
      if (option === '-u' || option === '--unset') {
        const name = tokens[index + 1] ?? ''
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          malformed = true
          index += 1
          break
        }
        delete env[name]
        changedNames.add(name)
        index += 2
        continue
      }
      if (option.startsWith('--unset=')) {
        const name = option.slice('--unset='.length)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          malformed = true
          index += 1
          break
        }
        delete env[name]
        changedNames.add(name)
        index += 1
        continue
      }
      if (option === '-i' || option === '--ignore-environment') {
        for (const name of Object.keys(env)) {
          delete env[name]
        }
        changedNames.add('*')
        index += 1
        continue
      }
      if (option === '--') {
        index += 1
        break
      }
      if (option.startsWith('-')) {
        malformed = true
        index += 1
        break
      }
      break
    }
    while (index < tokens.length) {
      const token = tokens[index] ?? ''
      const match = ENV_PREFIX_PATTERN.exec(token)
      if (!match) {
        break
      }
      const [, name, value] = match
      if (name) {
        env[name] = expandKnownVariables(value ?? '', env)
        changedNames.add(name)
      }
      index += 1
    }
    const commandTokens = tokens.slice(index)
    return {
      env,
      commandTokens,
      malformed: malformed || commandTokens.length === 0,
      changedNames,
    }
  }
  for (const token of tokens) {
    const match = ENV_PREFIX_PATTERN.exec(token)
    if (!match) {
      break
    }
    const [, name, value] = match
    if (name) {
      env[name] = expandKnownVariables(value ?? '', env)
      changedNames.add(name)
    }
  }
  return { env, malformed: false, changedNames }
}

function expandKnownVariables(
  token: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return token.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (raw, a, b) => {
      const value = env[a ?? b]
      return value === undefined ? raw : value
    },
  )
}

function stripRedirects(tokens: string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (isFdDuplication(token)) {
      continue
    }
    if (!isRedirectOperator(token)) {
      stripped.push(token)
      continue
    }
    if (token.includes('>') || token.includes('<')) {
      const inline = token.replace(/^\d*(?:>>?|<<?|<>|>\|)/, '')
      if (!inline) {
        index += 1
      }
    }
  }
  return stripped
}

function shellSegment(
  commandRedacted: string,
  segmentHead: string,
  requirements: ShellEffectRequirement[],
  opacity: EffectPlan['opacity'],
  signals: Set<string>,
): ShellEffectSegment {
  const normalizedRequirements = requirements.flatMap((entry) => {
    const dynamicSignal = dynamicResourceSignal(entry.resource)
    if (dynamicSignal) {
      return [
        { ...entry, resource: { kind: 'unknown' } as const },
        requirement(
          'indeterminate',
          'indeterminate',
          { kind: 'unknown' },
          entry.provenance.segment ?? commandRedacted,
          [...entry.evidence.signals, dynamicSignal],
        ),
      ]
    }
    return [entry]
  })
  const partial = normalizedRequirements.some(
    (entry) => entry.tag === 'indeterminate' || entry.action === 'indeterminate',
  )
  return {
    commandRedacted,
    segmentHead,
    requirements: normalizedRequirements,
    completeness: partial ? 'partial' : 'complete',
    opacity,
    signals: [...signals].sort(),
  }
}

const DYNAMIC_SHELL_VALUE_PATTERN =
  /(?:\$\(|`|\$(?:\d+|[@*#?$!-]|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*))/
const SHELL_GLOB_PATTERN = /[*?[]/

function effectChangingEnvironmentSignals(
  head: string,
  env: Readonly<Record<string, string | undefined>>,
  changedNames: ReadonlySet<string>,
): string[] {
  if (
    head === 'curl' &&
    (env.CURL_HOME ||
      changedNames.has('CURL_HOME') ||
      changedNames.has('HOME') ||
      changedNames.has('XDG_CONFIG_HOME'))
  ) {
    return ['egress.curl.environment_config_override']
  }
  if (head === 'wget' && (env.WGETRC || changedNames.has('WGETRC') || changedNames.has('HOME'))) {
    return ['egress.wget.environment_config_override']
  }
  if (head !== 'git') {
    return []
  }
  const hazardousNames = new Set([
    'GIT_ASKPASS',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_CONFIG',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_DIR',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_EDITOR',
    'GIT_EXEC_PATH',
    'GIT_EXTERNAL_DIFF',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PAGER',
    'GIT_PROXY_COMMAND',
    'GIT_QUARANTINE_PATH',
    'GIT_SEQUENCE_EDITOR',
    'GIT_SHALLOW_FILE',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_TEMPLATE_DIR',
    'GIT_WORK_TREE',
    'SSH_ASKPASS',
  ])
  const overridden =
    changedNames.has('HOME') ||
    changedNames.has('XDG_CONFIG_HOME') ||
    Object.entries(env).some(([name, value]) => {
      if (!value) {
        return false
      }
      if (
        hazardousNames.has(name) ||
        /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name) ||
        /^GIT_TRACE/.test(name)
      ) {
        return true
      }
      return name === 'GIT_CONFIG_COUNT' && value !== '0'
    })
  return overridden ? ['git.environment_execution_or_config_override'] : []
}

function dynamicResourceSignal(resource: ShellEffectRequirement['resource']): string | null {
  const expanded = (value: string | undefined): boolean =>
    Boolean(value && DYNAMIC_SHELL_VALUE_PATTERN.test(value))
  const pathLike = (value: string | undefined, allowSemanticWildcard = false): boolean =>
    Boolean(
      value && (expanded(value) || (!allowSemanticWildcard && SHELL_GLOB_PATTERN.test(value))),
    )
  switch (resource.kind) {
    case 'path':
      return pathLike(resource.path) ? 'shell.path_unresolved' : null
    case 'network':
      return expanded(resource.host) || expanded(resource.protocol)
        ? 'shell.network_resource_unresolved'
        : null
    case 'git-ref':
      return pathLike(resource.repoPath) || pathLike(resource.ref, resource.ref.endsWith('/*'))
        ? 'shell.git_resource_unresolved'
        : null
    case 'executable':
      return expanded(resource.command) ? 'shell.executable_unresolved' : null
    default:
      return null
  }
}

function processRequirement(
  command: string,
  operation: 'inspect' | 'spawn',
  segment: string,
  signals: string[],
): ShellEffectRequirement {
  return requirement(
    'process.exec',
    'process.exec',
    { kind: 'executable', command, operation },
    segment,
    signals,
  )
}

function unsupportedProcess(
  command: string,
  segment: string,
  signal: string,
): ShellEffectRequirement[] {
  return [
    processRequirement(command, 'spawn', segment, [signal]),
    requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [signal]),
  ]
}

function addWriteEffects(
  requirements: ShellEffectRequirement[],
  resolved: string,
  segment: string,
  signals: string[],
): void {
  requirements.push(
    requirement('fs.write', 'fs.write', { kind: 'path', path: resolved }, segment, signals),
  )
  if (CONTROL_PLANE_PATH_PATTERN.test(resolved)) {
    requirements.push(
      requirement(
        'control_plane.write',
        'control_plane.write',
        { kind: 'path', path: resolved },
        segment,
        [...signals, 'protected_path'],
      ),
    )
  }
}

function addSecretRead(
  requirements: ShellEffectRequirement[],
  resolved: string,
  segment: string,
): void {
  if (SECRET_PATH_PATTERN.test(resolved)) {
    requirements.push(
      requirement('secret.read', 'secret.read', { kind: 'path', path: resolved }, segment, [
        'secret_path_read',
      ]),
    )
  }
}

function filesystemReadOperands(head: string, args: string[]): string[] | null {
  switch (head) {
    case 'ls': {
      const operands = args.filter((arg) => arg && !arg.startsWith('-'))
      return operands.length > 0 ? operands : ['.']
    }
    case 'find':
      return findReadOperands(args)
    case 'cat':
    case 'head':
    case 'tail':
    case 'less':
    case 'stat':
    case 'file':
    case 'du':
    case 'wc':
      return args.filter((arg) => arg && !arg.startsWith('-'))
    case 'grep':
    case 'rg':
      return args.slice(1).filter((arg) => arg && !arg.startsWith('-'))
    case 'jq':
      return args.slice(1).filter((arg) => arg && !arg.startsWith('-'))
    default:
      return null
  }
}

function findReadOperands(args: string[]): string[] | null {
  const mutatingPrimaries = new Set([
    '-delete',
    '-exec',
    '-execdir',
    '-fls',
    '-fprint',
    '-fprintf',
    '-ok',
    '-okdir',
  ])
  if (
    args.some(
      (arg) =>
        mutatingPrimaries.has(arg) ||
        [...mutatingPrimaries].some((primary) => arg.startsWith(`${primary}=`)),
    )
  ) {
    return null
  }
  const paths: string[] = []
  for (const arg of args) {
    if (arg.startsWith('-') || arg === '!' || arg === '(') {
      break
    }
    paths.push(arg)
  }
  return paths.length > 0 ? paths : ['.']
}

function filesystemWriteOperands(head: string, args: string[]): string[] | null {
  const positional = args.filter((arg) => arg && !arg.startsWith('-'))
  switch (head) {
    case 'touch':
    case 'mkdir':
    case 'rm':
    case 'truncate':
    case 'chmod':
      return positional
    case 'cp':
    case 'mv':
      return positional.length > 0 ? [positional[positional.length - 1] ?? ''] : []
    case 'tee':
      return positional
    default:
      return null
  }
}

function validLsof(args: string[]): boolean {
  const flagsWithoutValues = new Set(['-a', '-b', '-l', '-n', '-P', '-R', '-t', '-V'])
  const flagsWithValues = new Set(['-c', '-d', '-F', '-g', '-p', '-T', '-u', '+d', '+D'])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (flagsWithoutValues.has(arg) || arg === '-i') {
      continue
    }
    if (flagsWithValues.has(arg)) {
      if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
        return false
      }
      index += 1
      continue
    }
    if (
      (/^-[ablnPRtV]+$/.test(arg) &&
        [...arg.slice(1)].every((flag) => 'ablnPRtV'.includes(flag))) ||
      /^-i(?:TCP|UDP)?(?::\d+(?:-\d+)?)?$/.test(arg) ||
      /^-s(?:TCP|UDP):[A-Za-z]+$/.test(arg) ||
      /^-(?:c|d|F|g|p|T|u).+$/.test(arg) ||
      /^\+(?:d|D).+$/.test(arg)
    ) {
      continue
    }
    return false
  }
  return true
}

function validPs(args: string[]): boolean {
  const bareForms = new Set(['aux', 'ax', 'x', 'u'])
  const flagsWithoutValues = new Set(['-A', '-a', '-d', '-e', '-f', '-j', '-l', '-T', '-x'])
  const flagsWithValues = new Set([
    '--format',
    '--group',
    '--pid',
    '--ppid',
    '--sort',
    '--tty',
    '--user',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (bareForms.has(arg) || flagsWithoutValues.has(arg)) {
      continue
    }
    if (flagsWithValues.has(arg)) {
      if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
        return false
      }
      index += 1
      continue
    }
    if (/^(?:--format|--group|--pid|--ppid|--sort|--tty|--user)=.+$/.test(arg)) {
      continue
    }
    if (/^-[^-]/.test(arg)) {
      const noValue = new Set(['A', 'a', 'd', 'e', 'f', 'j', 'l', 'T', 'x'])
      const withValue = new Set(['G', 'g', 'N', 'o', 'p', 't', 'U', 'u'])
      const characters = arg.slice(1)
      let valid = true
      for (let optionIndex = 0; optionIndex < characters.length; optionIndex += 1) {
        const option = characters[optionIndex] ?? ''
        if (noValue.has(option)) {
          continue
        }
        if (withValue.has(option)) {
          if (optionIndex === characters.length - 1) {
            if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
              return false
            }
            index += 1
          }
          break
        }
        valid = false
        break
      }
      if (valid) {
        continue
      }
    }
    return false
  }
  return true
}

function validFilesystemTest(head: string, args: string[]): boolean {
  const operands = head === '[' && args.at(-1) === ']' ? args.slice(0, -1) : args
  if (head === '[' && args.at(-1) !== ']') {
    return false
  }
  return (
    operands.length === 2 &&
    new Set(['-b', '-c', '-d', '-e', '-f', '-h', '-L', '-r', '-s', '-w', '-x']).has(
      operands[0] ?? '',
    ) &&
    Boolean(operands[1])
  )
}

function validDockerInfo(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--help') {
      continue
    }
    if (arg === '--format' || arg === '-f') {
      if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
        return false
      }
      index += 1
      continue
    }
    if (arg.startsWith('--format=')) {
      if (arg.slice('--format='.length).length === 0) {
        return false
      }
      continue
    }
    return false
  }
  return true
}

function bashSyntaxTarget(args: string[]): string | null {
  let syntaxOnly = false
  let script: string | null = null
  const shortFlags = new Set('abefhkmnptuvxBCEHPT'.split(''))
  const longFlags = new Set([
    '--debugger',
    '--dump-po-strings',
    '--dump-strings',
    '--help',
    '--login',
    '--noediting',
    '--noprofile',
    '--norc',
    '--posix',
    '--restricted',
    '--verbose',
    '--version',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '-c' || arg === '-lc') {
      return null
    }
    if (arg === '-O' || arg === '+O' || arg === '--rcfile' || arg === '--init-file') {
      if (!args[index + 1] || isOptionToken(args[index + 1] ?? '')) {
        return null
      }
      index += 1
      continue
    }
    if (
      (arg.startsWith('-O') && arg.length > 2) ||
      (arg.startsWith('+O') && arg.length > 2) ||
      (arg.startsWith('--rcfile=') && arg.length > '--rcfile='.length) ||
      (arg.startsWith('--init-file=') && arg.length > '--init-file='.length)
    ) {
      continue
    }
    if (longFlags.has(arg)) {
      continue
    }
    if (/^[+-][A-Za-z]+$/.test(arg)) {
      const options = arg.slice(1)
      if ([...options].some((option) => !shortFlags.has(option))) {
        return null
      }
      syntaxOnly ||= options.includes('n')
      continue
    }
    if (arg === '--') {
      script = args[index + 1] ?? null
      break
    }
    if (arg.startsWith('-') || arg.startsWith('+')) {
      return null
    }
    script = arg
    break
  }
  return syntaxOnly ? script : null
}

function isOptionToken(value: string): boolean {
  return value.startsWith('-') || value.startsWith('+')
}

function databaseEndpoint(
  raw: string | undefined,
): { host: string; protocol: string; port?: number } | null {
  if (!raw || raw.includes('$')) {
    return null
  }
  try {
    const url = new URL(raw)
    if (!url.hostname || !url.protocol) {
      return null
    }
    return {
      host: url.hostname.toLowerCase(),
      protocol: url.protocol.slice(0, -1),
      ...(url.port ? { port: Number(url.port) } : {}),
    }
  } catch {
    return null
  }
}

function resolvePathOperand(operand: string, cwd: string): string {
  if (operand === '~') {
    return process.env.HOME ?? operand
  }
  if (operand.startsWith('~/')) {
    return path.join(process.env.HOME ?? '~', operand.slice(2))
  }
  return path.resolve(cwd, operand)
}

function isShellHead(head: string): boolean {
  return head === 'bash' || head === 'sh' || head === 'zsh' || head === 'dash' || head === 'fish'
}

function pipeToShell(command: string): boolean {
  return /(?:^|[|;&]\s*)(?:bash|sh|zsh|dash|fish)(?:\s|$)/.test(command) && /\|/.test(command)
}

function withInnerProvenance(
  requirementValue: ShellEffectRequirement,
  innerCommand: string,
  launcher: string,
  outerSegment: string,
): ShellEffectRequirement {
  const provenance: EffectProvenance = {
    ...requirementValue.provenance,
    segment: outerSegment,
    innerCommand: requirementValue.provenance.innerCommand ?? innerCommand,
    ...(launcher === 'npm' || launcher === 'pnpm' ? { launcher, phase: 'delegate' as const } : {}),
  }
  const launcherProvenance: EffectProvenance = {
    segment: outerSegment,
    innerCommand,
    ...(launcher === 'npm' || launcher === 'pnpm' ? { launcher, phase: 'delegate' as const } : {}),
  }
  return withProvenances(requirementValue, provenance, launcherProvenance)
}

function withProvenances(
  requirementValue: ShellEffectRequirement,
  provenance: EffectProvenance,
  contributing: EffectProvenance,
): ShellEffectRequirement {
  const provenances = [
    ...(requirementValue.provenances ?? [requirementValue.provenance]),
    contributing,
    provenance,
  ].filter(
    (candidate, index, all) =>
      all.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(candidate)) === index,
  )
  return { ...requirementValue, provenance, provenances }
}

function ensureRequirement(
  requirements: ShellEffectRequirement[],
  candidate: ShellEffectRequirement,
): void {
  if (
    !requirements.some(
      (entry) =>
        entry.action === candidate.action &&
        JSON.stringify(entry.resource) === JSON.stringify(candidate.resource),
    )
  ) {
    requirements.push(candidate)
  }
}

function requirement(
  tag: ShellEffectRequirement['tag'],
  action: ShellEffectRequirement['action'],
  resource: ShellEffectRequirement['resource'],
  segment: string,
  signals: string[],
): ShellEffectRequirement {
  return {
    tag,
    action,
    resource,
    evidence: {
      level: tag === 'indeterminate' ? 'indeterminate' : 'certain',
      signals: [...new Set(signals)].sort(),
      basis: ['shell_semantic_lowering'],
    },
    provenance: { segment },
  }
}
