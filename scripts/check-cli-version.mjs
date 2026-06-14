import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version

const srcContent = readFileSync(path.join(root, 'src/version.ts'), 'utf8')
const srcMatch = srcContent.match(/PACKAGE_VERSION = '([^']+)'/)
const srcVersion = srcMatch?.[1]

if (srcVersion !== pkgVersion) {
  console.error(
    `check-cli-version: src/version.ts (${srcVersion ?? 'missing'}) != package.json (${pkgVersion})`,
  )
  process.exit(1)
}

const cliPath = path.join(root, 'dist/cli.js')
let cliVersion
try {
  cliVersion = execFileSync('node', [cliPath, '--version'], { encoding: 'utf8' }).trim()
} catch (error) {
  console.error(`check-cli-version: failed to run node dist/cli.js --version`)
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

if (cliVersion !== pkgVersion) {
  console.error(
    `check-cli-version: dist/cli.js --version (${cliVersion}) != package.json (${pkgVersion})`,
  )
  process.exit(1)
}

console.log(`check-cli-version: OK (${pkgVersion})`)
