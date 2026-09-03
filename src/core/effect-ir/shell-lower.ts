import path from 'node:path'

import { lexShell } from '../shell-tokenizer.js'
import { decodeDockerComposeRun as decodeStructuredDockerComposeRun } from '../verdict/docker-compose-run.js'
import { decodeEgressEffects } from '../verdict/egress-classify.js'
import { decodeGitEffects } from '../verdict/git-classifier.js'
import { resolveLauncherRecipe } from '../verdict/launcher-resolve.js'
import {
  decodeRecursiveInvocationTokens,
  parseSegment,
  redactCommand,
  segmentOpacity,
  splitStructuralShellSegments,
  structuralSubstitutionInners,
} from '../verdict/parser.js'
import { innerRecipeFromArgvDelegate, peelArgvDelegateArgv } from './argv-delegate.js'
import { joinEffectOpacity } from './normalize.js'
import { innerRecipeFromPeel, peelPackageExecArgv } from './package-exec.js'
import {
  buildShellEffectPlan,
  type ShellEffectRequirement,
  type ShellEffectSegment,
} from './shell-build.js'
import { isGrammarUnknownOnly, shouldApplyArgvDelegate } from './shell-lower/argv-delegate-gate.js'
import { addRedirectEffects, effectChangingEnvironmentSignals } from './shell-lower/augment.js'
import type { LowerContext, LowerShellEffectPlanParams } from './shell-lower/context.js'
import { decodeProcessOrFilesystem } from './shell-lower/decode-process.js'
import {
  decodePackageExec,
  packageExecInnerIsMetadata,
} from './shell-lower/decoders/decode-package-exec.js'
import {
  ensureRequirement,
  processRequirement,
  requirement,
  withInnerProvenance,
  withProvenances,
} from './shell-lower/requirement.js'
import {
  joinNestedOpacity,
  requiresKnownCwd,
  resolveCdTransition,
  shellSegment,
  startsLocalPostgresService,
} from './shell-lower/segment.js'
import {
  alignStructuredTokens,
  ENV_PREFIX_PATTERN,
  expandKnownVariables,
  extractEnvironment,
  isShellHead,
  pipeToShell,
  stripRedirects,
  stripStructuredRedirects,
} from './shell-lower/tokens.js'
import type { EffectPlan, EffectProvenance } from './types.js'

export type { LowerShellEffectPlanParams } from './shell-lower/context.js'

const MAX_LOWER_DEPTH = 8

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

function lowerSegment(
  command: string,
  context: LowerContext & { pipeToShellSegment?: boolean },
): ShellEffectSegment {
  const commandRedacted = redactCommand(command)
  const lexed = lexShell(command)
  const rawTokens = lexed.tokens.map((token) => token.value)
  const environment = extractEnvironment(rawTokens, context.env)
  const env = environment.env
  const parsed = parseSegment(command)
  const parsedTokens = environment.commandTokens ?? parsed.tokens
  const tokens = stripRedirects(
    parsedTokens.length === 0 &&
      rawTokens.length > 0 &&
      rawTokens.every((token) => ENV_PREFIX_PATTERN.test(token))
      ? rawTokens
      : parsedTokens,
  ).map((token) => expandKnownVariables(token, env))
  const decoderTokens = alignStructuredTokens(
    stripStructuredRedirects(lexed.tokens),
    stripRedirects(parsedTokens),
  )
  const head = path.basename(tokens[0] ?? parsed.head)
  let opacity = segmentOpacity(command)
  const signals = new Set<string>()
  const requirements: ShellEffectRequirement[] = []

  if (!lexed.complete) {
    requirements.push(
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
        'shell.grammar_incomplete',
      ]),
    )
    signals.add('shell.grammar_incomplete')
    opacity = joinEffectOpacity(opacity, 'unparseable')
  }

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

  if (context.depth > MAX_LOWER_DEPTH) {
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

  const recursive = decodeRecursiveInvocationTokens(decoderTokens)
  if (recursive.kind === 'static' && opacity !== 'opaque' && opacity !== 'unparseable') {
    requirements.push(
      processRequirement(recursive.interpreter, 'spawn', commandRedacted, [
        'shell.recursive_wrapper',
        'dynamic_shell_evaluation',
      ]),
    )
    if (recursive.script !== '') {
      const nested = lowerTopLevelSegments(recursive.script, {
        ...context,
        command: recursive.script,
        env,
        depth: context.depth + 1,
      })
      for (const nestedSegment of nested) {
        requirements.push(
          ...nestedSegment.requirements.map((entry) =>
            withInnerProvenance(entry, recursive.script, head, commandRedacted),
          ),
        )
        for (const signal of nestedSegment.signals) signals.add(signal)
      }
    }
    signals.add('shell.recursive_wrapper')
    signals.add('dynamic_shell_evaluation')
    return shellSegment(commandRedacted, head, requirements, 'recursive', signals)
  }
  if (recursive.kind === 'dynamic' || recursive.kind === 'indeterminate') {
    const recursiveSignals = [
      recursive.signal,
      ...(recursive.kind === 'dynamic' ? ['dynamic_shell_evaluation'] : []),
    ]
    requirements.push(
      processRequirement(recursive.interpreter, 'spawn', commandRedacted, recursiveSignals),
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
        ...recursiveSignals,
      ]),
    )
    for (const signal of recursiveSignals) signals.add(signal)
    return shellSegment(
      commandRedacted,
      head,
      requirements,
      joinEffectOpacity(opacity, 'opaque'),
      signals,
    )
  }

  const compose = decodeStructuredDockerComposeRun(decoderTokens)
  if (compose.kind === 'recursive' && opacity !== 'opaque' && opacity !== 'unparseable') {
    requirements.push(
      processRequirement(head, 'spawn', commandRedacted, ['process.docker_compose_run']),
    )
    if (compose.script !== '') {
      const nested = lowerTopLevelSegments(compose.script, {
        ...context,
        command: compose.script,
        env,
        depth: context.depth + 1,
      })
      for (const nestedSegment of nested) {
        requirements.push(
          ...nestedSegment.requirements.map((entry) =>
            withInnerProvenance(entry, compose.script, head, commandRedacted),
          ),
        )
        for (const signal of nestedSegment.signals) signals.add(signal)
        opacity = joinNestedOpacity(opacity, nestedSegment)
      }
    }
    signals.add('process.docker_compose_run')
    return shellSegment(commandRedacted, head, requirements, 'recursive', signals)
  }
  if (compose.kind === 'dynamic' || compose.kind === 'indeterminate') {
    requirements.push(
      processRequirement(head, 'spawn', commandRedacted, ['process.docker_compose_run']),
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
        compose.signal,
      ]),
    )
    signals.add('process.docker_compose_run')
    signals.add(compose.signal)
    return shellSegment(
      commandRedacted,
      head,
      requirements,
      joinEffectOpacity(opacity, 'opaque'),
      signals,
    )
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
      const processRequirements = decodeProcessOrFilesystem({
        tokens,
        head,
        env,
        cwd: context.cwd,
        repoRoot: context.repoRoot,
        segment: commandRedacted,
      })
      if (isGrammarUnknownOnly(processRequirements, head)) {
        const argvDelegate = peelArgvDelegateArgv(tokens)
        if (
          argvDelegate &&
          !argvDelegate.opaque &&
          shouldApplyArgvDelegate(head, argvDelegate.innerTokens, context.depth)
        ) {
          const innerRecipe = innerRecipeFromArgvDelegate(argvDelegate)
          if (innerRecipe) {
            requirements.push(
              processRequirement(head, 'inspect', commandRedacted, [
                'process.argv_delegate',
                ...argvDelegate.signals,
              ]),
            )
            for (const signal of argvDelegate.signals) {
              signals.add(signal)
            }
            const nested = lowerTopLevelSegments(innerRecipe, {
              ...context,
              command: innerRecipe,
              env,
              depth: context.depth + 1,
            })
            for (const nestedSegment of nested) {
              requirements.push(
                ...nestedSegment.requirements.map((entry) =>
                  withInnerProvenance(entry, innerRecipe, head, commandRedacted),
                ),
              )
              for (const signal of nestedSegment.signals) {
                signals.add(signal)
              }
              opacity = joinNestedOpacity(opacity, nestedSegment)
            }
            return shellSegment(commandRedacted, head, requirements, opacity, signals)
          }
        }
        if (argvDelegate?.opaque) {
          requirements.push(
            processRequirement(head, 'spawn', commandRedacted, [
              'process.argv_delegate',
              argvDelegate.reason,
              ...argvDelegate.signals,
            ]),
            requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
              argvDelegate.reason,
              'process.argv_delegate_opaque',
            ]),
          )
          for (const signal of argvDelegate.signals) {
            signals.add(signal)
          }
          signals.add('process.argv_delegate_opaque')
          return shellSegment(
            commandRedacted,
            head,
            requirements,
            joinEffectOpacity(opacity, 'opaque'),
            signals,
          )
        }
      }
      requirements.push(...processRequirements)
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
