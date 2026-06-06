#!/usr/bin/env node
import process from 'node:process'

import { doctorProject, formatDoctorReport } from './doctor.js'
import { initProject } from './installer.js'

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv
  const options: { targetDir?: string; nightly?: boolean; json?: boolean } = {}

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === '--nightly') {
      options.nightly = true
      continue
    }
    if (token === '--json') {
      options.json = true
      continue
    }
    if (token === '--target') {
      const next = rest[index + 1]
      if (!next) {
        throw new Error('--target requires a path value.')
      }
      options.targetDir = next
      index += 1
      continue
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help', options }
    }
    throw new Error(`Unknown argument: ${token}`)
  }

  return { command: command ?? 'help', options }
}

function printHelp() {
  process.stdout.write(`agent-belay

Usage:
  agent-belay init [--target <dir>] [--nightly]
  agent-belay doctor [--target <dir>] [--json]
`)
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2))
    if (command === 'help') {
      printHelp()
      return
    }

    if (command === 'init') {
      const result = await initProject(options)
      process.stdout.write(
        `Initialized agent-belay in ${result.repoRoot}${result.nightly ? ' (nightly extras enabled)' : ''}.\n`,
      )
      return
    }

    if (command === 'doctor') {
      const report = await doctorProject(options)
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(formatDoctorReport(report))
      }
      process.exitCode = report.ok ? 0 : 1
      return
    }

    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

await main()
