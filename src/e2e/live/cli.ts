import './load-e2e-env.ts'

import { consola } from 'consola'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { filterScenarios, formatScenarioList, parseArgs, resolveByIds } from './cli-utils.ts'
import type { LiveE2EScenario } from './scenario.ts'

export async function discoverScenarios(): Promise<LiveE2EScenario[]> {
  const liveDir = path.dirname(fileURLToPath(import.meta.url))
  const entries = fs.readdirSync(liveDir).sort()

  const scenarios: LiveE2EScenario[] = []
  for (const entry of entries) {
    if (!entry.startsWith('run') || !entry.endsWith('.ts')) {
      continue
    }
    if (entry === 'run.ts' || /^run-[\w-]+\.ts$/.test(entry)) {
      const modulePath = path.join(liveDir, entry)
      const mod = (await import(modulePath)) as { scenario?: LiveE2EScenario }
      if (mod.scenario && typeof mod.scenario.run === 'function') {
        scenarios.push(mod.scenario)
      }
    }
  }

  return scenarios
}

async function promptInteractive(scenarios: LiveE2EScenario[]): Promise<LiveE2EScenario[]> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, resolve)
    })

  try {
    consola.info('\nAvailable live E2E scenarios:\n')
    consola.info(formatScenarioList(scenarios))
    consola.info(
      '\nEnter scenario numbers (comma-separated), "all" to run all, or a search term to filter:',
    )

    const answer = (await ask('> ')).trim()

    if (!answer || answer.toLowerCase() === 'all') {
      return scenarios
    }

    if (/^[\d\s,]+$/.test(answer)) {
      const indices = answer
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10) - 1)
        .filter((n) => n >= 0 && n < scenarios.length)

      if (indices.length === 0) {
        throw new Error('No valid scenario numbers selected.')
      }

      return indices.map((i) => scenarios[i]!)
    }

    const filtered = filterScenarios(scenarios, answer)
    if (filtered.length === 0) {
      throw new Error(`No scenarios matching "${answer}".`)
    }
    return filtered
  } finally {
    rl.close()
  }
}

interface RunResult {
  durationMs: number
  error?: string
  id: string
  passed: boolean
  title: string
}

async function runScenarios(scenarios: LiveE2EScenario[]): Promise<RunResult[]> {
  const results: RunResult[] = []
  for (const scenario of scenarios) {
    consola.info(`\n${'─'.repeat(60)}`)
    consola.info(`Running: [${scenario.id}] ${scenario.title}`)
    consola.info(`${'─'.repeat(60)}\n`)

    const start = Date.now()
    try {
      await scenario.run()
      results.push({
        id: scenario.id,
        title: scenario.title,
        passed: true,
        durationMs: Date.now() - start,
      })
    } catch (error) {
      results.push({
        id: scenario.id,
        title: scenario.title,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      })
    }
  }
  return results
}

function printSummary(results: RunResult[]): void {
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0)

  consola.info(`\n${'═'.repeat(60)}`)
  consola.info('Live E2E Summary')
  consola.info(`${'═'.repeat(60)}`)

  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL'
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`
    consola.info(`  ${status}  ${r.id.padEnd(32)} ${dur}`)
    if (r.error) {
      consola.info(`        ${r.error}`)
    }
  }

  consola.info(`${'─'.repeat(60)}`)
  consola.info(
    `  Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Time: ${(totalMs / 1000).toFixed(1)}s`,
  )
  consola.info(`${'═'.repeat(60)}\n`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const allScenarios = await discoverScenarios()

  if (allScenarios.length === 0) {
    consola.error('No live E2E scenarios discovered.')
    process.exitCode = 1
    return
  }

  if (args.list) {
    const display = args.search ? filterScenarios(allScenarios, args.search) : allScenarios
    consola.info(`\nDiscovered ${display.length} live E2E scenario(s):\n`)
    consola.info(formatScenarioList(display))
    consola.info('')
    return
  }

  let selected: LiveE2EScenario[]

  if (args.scenarioIds.length > 0) {
    selected = resolveByIds(allScenarios, args.scenarioIds)
  } else if (args.interactive) {
    const pool = args.search ? filterScenarios(allScenarios, args.search) : allScenarios
    selected = await promptInteractive(pool)
  } else if (args.search) {
    selected = filterScenarios(allScenarios, args.search)
    if (selected.length === 0) {
      consola.error(`No scenarios matching "${args.search}".`)
      process.exitCode = 1
      return
    }
    consola.info(`Running ${selected.length} scenario(s) matching "${args.search}":\n`)
  } else {
    selected = allScenarios
    consola.info(`Running all ${selected.length} live E2E scenario(s).\n`)
  }

  const results = await runScenarios(selected)
  printSummary(results)

  if (results.some((r) => !r.passed)) {
    process.exitCode = 1
  }
}

await main()
