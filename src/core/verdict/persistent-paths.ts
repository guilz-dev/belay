/**
 * M3 catalog: paths that survive reboot or change agent startup.
 * @see docs/adr/tier0-retention-ledger.md
 */
export const PERSISTENT_AGENT_PATH_MARKERS = [
  '.ssh/authorized_keys',
  '.zshrc',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.config/',
  '/crontab',
  'LaunchAgents/',
  '/Library/LaunchDaemons/',
] as const

export const OUTSIDE_REPO_SECRET_CREDENTIAL_MARKERS = [
  '.env',
  '.env.*',
  '*.pem',
  '.ssh/id_*',
  '.aws/',
  '.npmrc',
  '.git-credentials',
  '.netrc',
  '.kube/config',
  '.docker/config.json',
  '.gnupg/',
  '.pypirc',
] as const

export function isPersistentAgentPath(resolvedPath: string): boolean {
  const normalized = resolvedPath.replaceAll('\\', '/')
  return (
    /\.ssh\/authorized_keys$/i.test(normalized) ||
    /\/\.(zshrc|bashrc|bash_profile|profile)$/i.test(normalized) ||
    /\/\.config\//i.test(normalized) ||
    /\/crontab$/i.test(normalized) ||
    /LaunchAgents\//i.test(normalized) ||
    /\/Library\/LaunchDaemons\//i.test(normalized)
  )
}

export function isOutsideRepoSecretCredentialPath(resolvedPath: string): boolean {
  const normalized = resolvedPath.replaceAll('\\', '/')
  return (
    /\/\.env(?:\.[^/]+)?$/i.test(normalized) ||
    /\/[^/]+\.pem$/i.test(normalized) ||
    /\/\.ssh\/id_[^/]+$/i.test(normalized) ||
    /\/\.aws\//i.test(normalized) ||
    /\/\.npmrc$/i.test(normalized) ||
    /\/\.git-credentials$/i.test(normalized) ||
    /\/\.netrc$/i.test(normalized) ||
    /\/\.kube\/config$/i.test(normalized) ||
    /\/\.docker\/config\.json$/i.test(normalized) ||
    /\/\.gnupg\//i.test(normalized) ||
    /\/\.pypirc$/i.test(normalized)
  )
}
