import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { resetPinnedJudgeModelsCache } from '../core/v2/judge-factory.js'

let isolatedHome: string | undefined

beforeEach(() => {
  isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'belay-test-home-'))
  process.env.HOME = isolatedHome
  process.env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config')
})

afterEach(() => {
  resetPinnedJudgeModelsCache()
  if (isolatedHome) {
    rmSync(isolatedHome, { recursive: true, force: true })
    isolatedHome = undefined
  }
})
