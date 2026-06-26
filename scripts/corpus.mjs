import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { hardGateLimitFailures, runCorpusEvaluation } = await import(
  path.join(root, 'dist/corpus/evaluate.js')
)

const metrics = await runCorpusEvaluation(path.join(root, 'corpus'))
const baseline = JSON.parse(await readFile(path.join(root, 'corpus', 'baseline.json'), 'utf8'))

const { gates } = metrics
const limits = baseline.hardGates ?? {}

console.log('Corpus evaluation')
console.log(`  cases: ${metrics.total}`)
console.log(`  accuracy: ${(metrics.accuracy * 100).toFixed(1)}%`)
console.log(
  `  categories: must-ask=${metrics.categoryCounts['must-ask']} provably-benign=${metrics.categoryCounts['provably-benign']} accepted-benign=${metrics.categoryCounts['accepted-benign']}`,
)
console.log('  hard gates:')
console.log(
  `    must-ask miss rate: ${(metrics.missRate * 100).toFixed(1)}% (${gates.mustAsk.mismatches}/${gates.mustAsk.total})`,
)
console.log(
  `    provably-benign over-stop rate: ${(metrics.benignBlockRate * 100).toFixed(1)}% (${gates.provablyBenign.mismatches}/${gates.provablyBenign.total})`,
)
console.log(
  `    accepted-benign (review-required, soft gate): ${gates.acceptedBenign.mismatches}/${gates.acceptedBenign.total} mismatches`,
)
for (const verdict of ['allow', 'allow_flagged', 'deny_pending_approval']) {
  console.log(
    `  ${verdict}: precision=${(metrics.precision[verdict] * 100).toFixed(1)}% recall=${(metrics.recall[verdict] * 100).toFixed(1)}%`,
  )
}

if (metrics.mismatches.length > 0) {
  console.log('\nMismatches:')
  for (const mismatch of metrics.mismatches.slice(0, 10)) {
    console.log(
      `  - [${mismatch.category}] ${JSON.stringify(mismatch.command)} expected=${mismatch.expected} actual=${mismatch.actual} (${mismatch.reason})`,
    )
  }
}

const failures = hardGateLimitFailures(gates, limits)
for (const gate of failures) {
  if (gate === 'must-ask') {
    console.error(
      `\nFAIL: must-ask misses ${gates.mustAsk.mismatches} (hard gate allows ${limits.mustAskMisses ?? 0})`,
    )
  }
  if (gate === 'provably-benign') {
    console.error(
      `\nFAIL: provably-benign over-stops ${gates.provablyBenign.mismatches} (hard gate allows ${limits.provablyBenignBlocks ?? 0})`,
    )
  }
}

process.exit(failures.length > 0 ? 1 : 0)
