import type { LiveE2EScenario } from './scenario.ts'

export interface CliArgs {
  interactive: boolean
  list: boolean
  scenarioIds: string[]
  search: string | undefined
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    interactive: false,
    list: false,
    search: undefined,
    scenarioIds: [],
  }

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!

    if (arg === '--interactive' || arg === '-i') {
      args.interactive = true
    } else if (arg === '--list' || arg === '-l') {
      args.list = true
    } else if (arg === '--search' || arg === '-s') {
      i += 1
      args.search = argv[i]
    } else if (arg.startsWith('--search=')) {
      args.search = arg.slice('--search='.length)
    } else if (!arg.startsWith('-')) {
      args.scenarioIds.push(arg)
    }

    i += 1
  }

  return args
}

export function filterScenarios(scenarios: LiveE2EScenario[], search: string): LiveE2EScenario[] {
  const needle = search.toLowerCase()
  return scenarios.filter(
    (s) =>
      s.id.toLowerCase().includes(needle) ||
      s.title.toLowerCase().includes(needle) ||
      s.description.toLowerCase().includes(needle) ||
      s.keywords.some((k) => k.toLowerCase().includes(needle)),
  )
}

export function resolveByIds(scenarios: LiveE2EScenario[], ids: string[]): LiveE2EScenario[] {
  const resolved: LiveE2EScenario[] = []
  for (const id of ids) {
    const needle = id.toLowerCase()
    // 优先 exact id 匹配；其次 exact keyword 匹配；最后 substring 模糊。
    // 防止 "auto-compact" 误中 "auto-compact-no-rework"（按 readdir 顺序首个 substring 命中）。
    const exactId = scenarios.find((s) => s.id.toLowerCase() === needle)
    const exactKeyword =
      exactId ?? scenarios.find((s) => s.keywords.some((k) => k.toLowerCase() === needle))
    const match = exactKeyword ?? scenarios.find((s) => s.id.toLowerCase().includes(needle))
    if (!match) {
      throw new Error(`No scenario matching "${id}". Use --list to see available scenarios.`)
    }
    if (!resolved.includes(match)) {
      resolved.push(match)
    }
  }
  return resolved
}

export function formatScenarioList(scenarios: LiveE2EScenario[]): string {
  const lines: string[] = []
  for (let i = 0; i < scenarios.length; i += 1) {
    const s = scenarios[i]!
    lines.push(`  ${String(i + 1).padStart(2)}. [${s.id}] ${s.title}`)
    lines.push(`      ${s.description}`)
  }
  return lines.join('\n')
}
