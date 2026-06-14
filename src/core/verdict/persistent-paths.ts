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
