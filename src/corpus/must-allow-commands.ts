/**
 * Structural-suite MUST-ALLOW ledger — keep in sync with standing-allow catalog generation.
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
] as const
