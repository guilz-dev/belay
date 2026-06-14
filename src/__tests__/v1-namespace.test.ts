import { describe, expect, it } from 'vitest'

import * as v1 from '../core/v1/index.js'
import * as v2 from '../core/v2/index.js'

describe('v1 namespace compatibility', () => {
  it('re-exports the v2 verdict engine surface', () => {
    expect(Object.keys(v1).sort()).toEqual(Object.keys(v2).sort())
  })
})
