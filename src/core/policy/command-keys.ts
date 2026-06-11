/**
 * Single source for built-in command-key buckets used by analysis and policy rules.
 * L3 noise-reduction cache — not a security boundary. Updates ship in minor releases;
 * see docs/semver-policy.md.
 */

export const READ_ONLY_COMMAND_KEYS = [
  'cat',
  'cd',
  'echo',
  'git diff',
  'git log',
  'git rev-parse',
  'git show',
  'git status',
  'head',
  'ls',
  'pwd',
  'rg',
  'sort',
  'tail',
  'wc',
  'which',
  'find',
] as const

export const FLAGGED_COMMAND_KEYS = [
  'chmod',
  'cp',
  'git add',
  'git clean',
  'git commit',
  'git mv',
  'git reset',
  'mkdir',
  'mv',
  'rm',
  'sed',
  'tee',
  'touch',
  'truncate',
] as const

export const EXTERNAL_COMMAND_KEYS = [
  'aws',
  'curl',
  'docker push',
  'docker run',
  'firebase deploy',
  'fly deploy',
  'gh',
  'git push',
  'gcloud',
  'heroku',
  'kubectl',
  'netlify',
  'npm publish',
  'pnpm publish',
  'rsync',
  'scp',
  'ssh',
  'supabase',
  'terraform apply',
  'vercel',
  'wget',
] as const

export const READ_ONLY_KEYS = new Set<string>(READ_ONLY_COMMAND_KEYS)
export const FLAGGED_KEYS = new Set<string>(FLAGGED_COMMAND_KEYS)
export const EXTERNAL_KEYS = new Set<string>(EXTERNAL_COMMAND_KEYS)
