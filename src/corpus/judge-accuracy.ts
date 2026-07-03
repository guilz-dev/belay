import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CorpusSchemaError } from './types.js'

export interface JudgeAccuracyCase {
  command: string
  expectedPermission: 'allow' | 'ask'
  category: string
  whyThisExists: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJudgeAccuracyCases(raw: unknown): JudgeAccuracyCase[] {
  if (!Array.isArray(raw)) {
    throw new CorpusSchemaError('judge-accuracy fixture must be a JSON array')
  }

  return raw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CorpusSchemaError(`judge-accuracy[${index}] must be an object`)
    }
    const command = entry.command
    if (typeof command !== 'string' || command.trim() === '') {
      throw new CorpusSchemaError(`judge-accuracy[${index}].command must be a non-empty string`)
    }
    const expectedPermission = entry.expectedPermission
    if (expectedPermission !== 'allow' && expectedPermission !== 'ask') {
      throw new CorpusSchemaError(
        `judge-accuracy[${index}].expectedPermission must be allow | ask (got ${JSON.stringify(expectedPermission)})`,
      )
    }
    const category = entry.category
    if (typeof category !== 'string' || category.trim() === '') {
      throw new CorpusSchemaError(`judge-accuracy[${index}].category must be a non-empty string`)
    }
    const whyThisExists = entry.whyThisExists
    if (typeof whyThisExists !== 'string' || whyThisExists.trim() === '') {
      throw new CorpusSchemaError(
        `judge-accuracy[${index}].whyThisExists must be a non-empty string`,
      )
    }
    return { command, expectedPermission, category, whyThisExists }
  })
}

export async function loadJudgeAccuracyCases(corpusDir?: string): Promise<JudgeAccuracyCase[]> {
  const root =
    corpusDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus')
  const raw = await readFile(path.join(root, 'judge-accuracy.json'), 'utf8')
  return parseJudgeAccuracyCases(JSON.parse(raw))
}
