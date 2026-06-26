import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { runCorpusEvaluation } = await import(path.join(root, 'dist/corpus/evaluate.js'))

const metrics = await runCorpusEvaluation(path.join(root, 'corpus'))
const baseline = JSON.parse(await readFile(path.join(root, 'corpus', 'baseline.json'), 'utf8'))

console.log('Corpus evaluation')
console.log(`  cases: ${metrics.total}`)
console.log(`  accuracy: ${(metrics.accuracy * 100).toFixed(1)}%`)
console.log(`  falsePositiveRate: ${(metrics.falsePositiveRate * 100).toFixed(1)}%`)
console.log(
  `  categories: must-ask=${metrics.categoryCounts['must-ask']} provably-benign=${metrics.categoryCounts['provably-benign']} accepted-benign=${metrics.categoryCounts['accepted-benign']}`,
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
      `  - ${JSON.stringify(mismatch.command)} expected=${mismatch.expected} actual=${mismatch.actual} (${mismatch.reason})`,
    )
  }
}

const baselineMetrics = baseline.metrics
let failed = false
if (metrics.accuracy < baselineMetrics.accuracy) {
  console.error(`\nFAIL: accuracy ${metrics.accuracy} < baseline ${baselineMetrics.accuracy}`)
  failed = true
}
if (metrics.falsePositiveRate > baselineMetrics.falsePositiveRate) {
  console.error(
    `\nFAIL: falsePositiveRate ${metrics.falsePositiveRate} > baseline ${baselineMetrics.falsePositiveRate}`,
  )
  failed = true
}

process.exit(failed ? 1 : 0)
