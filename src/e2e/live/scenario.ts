import { consola } from 'consola'

export interface LiveE2EScenario {
  description: string
  id: string
  keywords: string[]
  run: () => Promise<void>
  title: string
}

export function runDirectly(scenario: LiveE2EScenario): void {
  const entry = process.argv[1]
  const expectedTs = scenarioFileName(scenario.id)
  const expectedJs = expectedTs.replace('.ts', '.js')
  const isDirectRun =
    entry !== undefined && (entry.endsWith(`/${expectedTs}`) || entry.endsWith(`/${expectedJs}`))

  if (isDirectRun) {
    void scenario.run().catch((error) => {
      consola.error(error)
      process.exitCode = 1
    })
  }
}

function scenarioFileName(id: string): string {
  return id === 'full' ? 'run.ts' : `run-${id}.ts`
}
