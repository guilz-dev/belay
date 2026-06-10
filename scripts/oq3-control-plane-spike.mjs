#!/usr/bin/env node
/**
 * OQ3 spike CLI — run from repo root or any cwd to verify control-plane FS access.
 * Usage: node scripts/oq3-control-plane-spike.mjs
 */
import { runControlPlaneSpike } from '../dist/core/control-plane-spike.js'

const result = await runControlPlaneSpike()
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
