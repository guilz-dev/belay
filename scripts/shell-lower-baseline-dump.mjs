import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = path.join(root, 'scratchpad', 'shell-lower-baseline.json')
const workspace = '/workspace/project'

/** @type {ReadonlyArray<{ name: string; command: string; cwd?: string; repoRoot?: string }>} */
const BASELINE_CASES = [
  { name: 'git-status', command: 'git status --short' },
  { name: 'git-diff', command: 'git diff HEAD' },
  { name: 'docker-info', command: 'docker info' },
  { name: 'docker-compose-up', command: 'docker compose up -d' },
  { name: 'docker-run', command: 'docker run --rm alpine echo hi' },
  { name: 'ruby-rails-routes', command: 'bundle exec rails routes' },
  { name: 'rubocop', command: 'bundle exec rubocop app/models/user.rb' },
  { name: 'rsync-local', command: 'rsync -a src/ dest/' },
  { name: 'rsync-remote', command: 'rsync -a ./build/ user@host:/var/www/' },
  { name: 'rm-file', command: 'rm -f tmp/cache.txt' },
  { name: 'cp-file', command: 'cp src/a.txt dest/b.txt' },
  { name: 'mv-file', command: 'mv old.txt new.txt' },
  { name: 'prisma-migrate', command: 'prisma migrate dev' },
  { name: 'prisma-generate', command: 'prisma generate' },
  { name: 'belay-config-get', command: 'belay config get judge.mode' },
  { name: 'tsc-no-emit', command: 'tsc --noEmit' },
  { name: 'go-build', command: 'go build ./...' },
  { name: 'node-script', command: 'node scripts/build-runtime.mjs' },
  { name: 'sed-inplace', command: "sed -i '' 's/foo/bar/g' file.txt" },
  { name: 'npm-version', command: 'npm --version' },
  { name: 'pnpm-publish', command: 'pnpm publish --dry-run' },
  { name: 'npx-package', command: 'npx vitest run' },
  { name: 'argv-delegate-rtk', command: 'rtk git status --short' },
  { name: 'argv-delegate-generic', command: 'fictional-runner git diff' },
  { name: 'shell-echo', command: 'echo hello' },
  { name: 'shell-cd', command: 'cd src && pwd' },
  { name: 'env-prefix', command: 'NODE_ENV=test npm test' },
  { name: 'curl-egress', command: 'curl https://example.com/health' },
  { name: 'make-target', command: 'make verify-parallel' },
  { name: 'lsof-inspect', command: 'lsof -i :3000' },
  { name: 'ps-inspect', command: 'ps aux | grep node' },
  { name: 'vite-dev', command: 'vite dev' },
  { name: 'unknown-wrapper', command: 'unknown-wrapper' },
  { name: 'pipe-to-shell', command: 'git log | head' },
]

async function loadLowerShellEffectPlan() {
  const modulePath = path.join(root, 'dist/core/effect-ir/shell-lower.js')
  const { lowerShellEffectPlan } = await import(modulePath)
  return lowerShellEffectPlan
}

async function buildBaseline(lowerShellEffectPlan) {
  /** @type {Record<string, unknown>} */
  const results = {}
  for (const entry of BASELINE_CASES) {
    const cwd = entry.cwd ?? workspace
    const repoRoot = entry.repoRoot ?? cwd
    results[entry.name] = lowerShellEffectPlan({
      command: entry.command,
      cwd,
      repoRoot,
      inputFingerprint: `baseline:${entry.name}`,
    })
  }
  return results
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeBaseline() {
  const lowerShellEffectPlan = await loadLowerShellEffectPlan()
  const baseline = await buildBaseline(lowerShellEffectPlan)
  await writeFile(baselinePath, stableStringify(baseline))
  console.log(`Wrote ${baselinePath} (${BASELINE_CASES.length} cases)`)
}

async function checkBaseline() {
  const lowerShellEffectPlan = await loadLowerShellEffectPlan()
  const expected = JSON.parse(await readFile(baselinePath, 'utf8'))
  const actual = await buildBaseline(lowerShellEffectPlan)
  const expectedJson = stableStringify(expected)
  const actualJson = stableStringify(actual)
  if (expectedJson !== actualJson) {
    console.error('FAIL: shell-lower baseline mismatch')
    for (const entry of BASELINE_CASES) {
      const before = stableStringify(expected[entry.name])
      const after = stableStringify(actual[entry.name])
      if (before !== after) {
        console.error(`  - ${entry.name}: output changed`)
      }
    }
    process.exit(1)
  }
  console.log(`OK: shell-lower baseline matches (${BASELINE_CASES.length} cases)`)
}

const mode = process.argv[2] ?? 'write'
if (mode === '--check' || mode === 'check') {
  await checkBaseline()
} else if (mode === '--write' || mode === 'write') {
  await writeBaseline()
} else {
  console.error(`Usage: node scripts/shell-lower-baseline-dump.mjs [--write|--check]`)
  process.exit(1)
}
