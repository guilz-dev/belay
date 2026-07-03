import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { main } = await import(path.join(root, 'dist/corpus/adversarial-probe.js'))

const exitCode = await main(process.argv.slice(2))
process.exit(exitCode)
