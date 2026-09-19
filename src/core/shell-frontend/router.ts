import type { EffectPlan } from '../effect-ir/types.js'
import { authorizationProjectionsEqual } from './compare.js'
import { legacyShellFrontend } from './legacy-frontend.js'
import { mvdanShellFrontend } from './mvdan-frontend.js'
import type { ParsedShellProgram, ShellFrontendMode } from './types.js'

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
      disagreement: false,
    }
  }

  return {
    mode,
    canonicalId: 'mvdan-v1',
    canonicalProgram: mvdan,
    candidateProgram: legacy,
    disagreement: syntaxDisagrees(legacy, mvdan),
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

function syntaxDisagrees(legacy: ParsedShellProgram, mvdan: ParsedShellProgram): boolean {
  return (
    legacy.completeness !== mvdan.completeness ||
    legacy.diagnostics.map((diagnostic) => diagnostic.code).join(',') !==
      mvdan.diagnostics.map((diagnostic) => diagnostic.code).join(',')
  )
}
