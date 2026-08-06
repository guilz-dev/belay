import { matchesSensitivePath } from '../glob.js'
import { resolveMutationTarget, resolveWorkspaceRootMatch } from '../path-utils.js'
import { resolveTrustedPath } from './containment.js'
import { isOutsideRepoSecretCredentialPath, isPersistentAgentPath } from './persistent-paths.js'
import type { Tier1Verdict } from './types.js'

const SECRET_PATTERNS = [/\.env\b/i, /\.pem\b/i, /id_rsa\b/i, /credentials/i, /secrets?\b/i]
const DESTRUCTIVE_VERBS = /\b(rm|rmtree|unlink|delete|truncate|shred|destroy|drop)\b/i
const GIT_PATTERNS = /\.git\b/i

export function prescanInterpreterCode(code: string): Tier1Verdict | null {
  const normalized = code.replaceAll('\\', '/')
  const hitsSecret = SECRET_PATTERNS.some((pattern) => pattern.test(normalized))
  const hitsGit = GIT_PATTERNS.test(normalized)
  const hitsDestructive = DESTRUCTIVE_VERBS.test(normalized)
  if ((hitsSecret || hitsGit) && hitsDestructive) {
    return {
      local_recoverable: true,
      destroys_outside_repo: false,
      destroys_history_or_secrets: true,
      reason: 'prescan_destructive_secret',
    }
  }
  return null
}

export interface MutationPrescanParams {
  targets: string[]
  cwd: string
  repoRoot: string
  trustedCwd: boolean
  trustedWorkspaceRoots?: string[]
  sensitivePaths: string[]
}

/** ADR-002 M3: structural prescan for sensitive / persistent mutation targets (shell redirects, etc.). */
export function prescanMutationTargets(params: MutationPrescanParams): Tier1Verdict | null {
  for (const target of params.targets) {
    const resolved =
      resolveTrustedPath(target, params.cwd, params.trustedCwd) ??
      resolveMutationTarget(target, params.cwd)
    if (!resolved) {
      continue
    }
    const workspaceMatch = resolveWorkspaceRootMatch(
      params.repoRoot,
      params.trustedWorkspaceRoots,
      resolved,
    )
    if (
      workspaceMatch !== null &&
      matchesSensitivePath(workspaceMatch.relativePath.replaceAll('\\', '/'), params.sensitivePaths)
    ) {
      return {
        local_recoverable: false,
        destroys_outside_repo: false,
        destroys_history_or_secrets: true,
        reason: 'sensitive_path_mutation',
      }
    }
    if (
      (workspaceMatch === null || workspaceMatch.kind === 'trusted') &&
      isOutsideRepoSecretCredentialPath(resolved)
    ) {
      return {
        local_recoverable: false,
        destroys_outside_repo: false,
        destroys_history_or_secrets: true,
        reason: 'outside_repo_secret_credential_path',
      }
    }
    if (isPersistentAgentPath(resolved)) {
      return {
        local_recoverable: false,
        destroys_outside_repo: false,
        destroys_history_or_secrets: true,
        reason: 'persistent_agent_path',
      }
    }
  }
  return null
}

/** Returns prescan verdict when structural M3 rules require ask (before async judge shadow). */
export function mutationPrescanRequiresAsk(params: MutationPrescanParams): Tier1Verdict | null {
  const prescan = prescanMutationTargets(params)
  return prescan && tier1RequiresAsk(prescan) ? prescan : null
}

export function tier1RequiresAsk(verdict: Tier1Verdict): boolean {
  return !verdict.local_recoverable || verdict.destroys_history_or_secrets
}
