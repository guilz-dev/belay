/**
 * Structural-suite MUST-ALLOW CI expectations.
 * These commands guard classifier availability in tests and never grant runtime authority.
 * @see src/__tests__/verdict/structural-suite.test.ts
 */
export const MUST_ALLOW_SHELL_COMMANDS = [
  'npm test',
  'npm run build',
  'pnpm test',
  'pnpm build',
  'pnpm vitest run src/example.test.ts',
  "bash -lc 'git status'",
  'belay approve belay_deadbeef1234',
  'bundle -v',
  'ruby -v',
  'yarn --version',
  'make -n test',
  'bin/rails routes',
  'bundle exec rubocop --version',
] as const
