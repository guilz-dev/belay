import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

describe('one-shot approval architecture boundary', () => {
  it('keeps one-shot approval transition primitives outside the gate runtime', async () => {
    const gateRuntime = await readFile(
      path.join(REPO_ROOT, 'src/adapters/shared/gate-runtime.ts'),
      'utf8',
    )

    for (const forbidden of [
      /ApprovalConsumeMutationResult/,
      /approvalGrantBundleExhausted/,
      /consumeApprovedRecordGrantBundle/,
      /decrementApprovalLegacyGrant/,
      /validateAndConsumeGrantBundle/,
      /validateGrantBundleForLeaseReuse/,
    ]) {
      expect(gateRuntime, `one-shot transition primitive ${forbidden}`).not.toMatch(forbidden)
    }
  })

  it('keeps the pure lifecycle free of outer-layer dependencies', async () => {
    const lifecycle = await readFile(
      path.join(REPO_ROOT, 'src/core/one-shot-approval-lifecycle.ts'),
      'utf8',
    )

    for (const forbidden of [
      /node:(?:fs|process)/,
      /config-io/,
      /adapters\//,
      /commands\//,
      /services\//,
      /audit/,
      /notify/,
    ]) {
      expect(lifecycle, `forbidden dependency ${forbidden}`).not.toMatch(forbidden)
    }
  })
})
