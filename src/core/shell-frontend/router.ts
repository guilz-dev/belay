import type { EffectPlan } from '../effect-ir/types.js'
import { canonicalStringify } from '../fingerprint.js'
import { authorizationProjectionsEqual } from './compare.js'
import { legacyShellFrontend } from './legacy-frontend.js'
import { mvdanShellFrontend } from './mvdan-frontend.js'
import type { ParsedShellProgram, ShellFrontendMode, ShellSyntaxNode } from './types.js'

export interface ShellFrontendRoute {
  mode: ShellFrontendMode
  canonicalId: 'legacy-v1' | 'mvdan-v1'
  canonicalProgram?: ParsedShellProgram
  candidateProgram?: ParsedShellProgram
  disagreement: boolean
}

/**
 * Select syntax frontends for a rollout mode.
 * Never returns the more permissive program. EffectPlan authority is applied separately.
 */
export async function routeShellFrontend(
  command: string,
  mode: ShellFrontendMode,
): Promise<ShellFrontendRoute> {
  if (mode === 'legacy') {
    return {
      mode,
      canonicalId: 'legacy-v1',
      canonicalProgram: await legacyShellFrontend.parse(command),
      disagreement: false,
    }
  }
  if (mode === 'mvdan') {
    return {
      mode,
      canonicalId: 'mvdan-v1',
      canonicalProgram: await mvdanShellFrontend.parse(command),
      disagreement: false,
    }
  }

  const legacy = await legacyShellFrontend.parse(command)
  const mvdan = await mvdanShellFrontend.parse(command)
  if (mode === 'shadow') {
    return {
      mode,
      canonicalId: 'legacy-v1',
      canonicalProgram: legacy,
      candidateProgram: mvdan,
      disagreement: shellProgramsDisagree(legacy, mvdan),
    }
  }

  return {
    mode,
    canonicalId: 'mvdan-v1',
    canonicalProgram: mvdan,
    candidateProgram: legacy,
    disagreement: shellProgramsDisagree(legacy, mvdan),
  }
}

export function selectCanonicalEffectPlan(params: {
  mode: ShellFrontendMode
  legacy: EffectPlan
  mvdan: EffectPlan
  withDisagreement: (plan: EffectPlan) => EffectPlan
}): EffectPlan {
  if (params.mode === 'legacy' || params.mode === 'shadow') {
    return params.legacy
  }
  if (params.mode === 'mvdan') {
    return params.mvdan
  }
  if (authorizationProjectionsEqual(params.legacy, params.mvdan)) {
    return params.mvdan
  }
  return params.withDisagreement(params.mvdan)
}

export function shellProgramsDisagree(
  legacy: ParsedShellProgram,
  mvdan: ParsedShellProgram,
): boolean {
  return canonicalStringify(syntaxShape(legacy)) !== canonicalStringify(syntaxShape(mvdan))
}

function syntaxShape(program: ParsedShellProgram): unknown {
  return {
    completeness: program.completeness,
    diagnostics: program.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    nodes: program.nodes.map(nodeShape),
  }
}

function nodeShape(node: ShellSyntaxNode): unknown {
  const span = node.span
  switch (node.kind) {
    case 'command':
      return {
        kind: node.kind,
        span,
        assignments: node.assignments.length,
        words: node.words.length,
        redirects: node.redirects.length,
      }
    case 'unsupported':
      return { kind: node.kind, span, upstreamKind: node.upstreamKind }
    case 'and_or':
      return {
        kind: node.kind,
        span,
        operator: node.operator,
        left: nodeShape(node.left),
        right: nodeShape(node.right),
      }
    case 'pipeline':
      return {
        kind: node.kind,
        span,
        negated: node.negated,
        children: node.children.map(nodeShape),
      }
    case 'sequence':
    case 'subshell':
    case 'brace_group':
    case 'if':
    case 'loop':
    case 'case':
    case 'function':
    case 'command_substitution':
    case 'process_substitution':
      return { kind: node.kind, span, children: node.children.map(nodeShape) }
    default: {
      const unreachable: never = node
      return unreachable
    }
  }
}
