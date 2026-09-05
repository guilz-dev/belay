/**
 * Structural-suite benign probe cores.
 * These commands guard classifier availability in tests and never grant runtime authority.
 * @see src/__tests__/verdict/structural-suite.test.ts
 */
export const BENIGN_PROBE_CORES = [
  'npm test',
  'npm run build',
  'pnpm test',
  'pnpm build',
  'pnpm vitest run src/example.test.ts',
  "bash -lc 'git status'",
  'bundle -v',
  'ruby -v',
  'yarn --version',
  'make -n test',
  'bin/rails routes',
  'bundle exec rubocop --version',
  'bundle exec rubocop test/upgrade_script_contract_test.rb',
  'ruby -Itest test/upgrade_script_contract_test.rb',
] as const
