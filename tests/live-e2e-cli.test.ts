import { describe, expect, it } from 'vitest'
import { filterScenarios, parseArgs, resolveByIds } from '@/e2e/live/cli-utils.ts'
import type { LiveE2EScenario } from '@/e2e/live/scenario.ts'

function makeScenario(overrides: Partial<LiveE2EScenario> & { id: string }): LiveE2EScenario {
  return {
    title: overrides.id,
    description: '',
    keywords: [],
    run: async () => {},
    ...overrides,
  }
}

describe('parseArgs', () => {
  it('returns defaults when no args are provided', () => {
    const result = parseArgs([])
    expect(result).toEqual({
      interactive: false,
      list: false,
      search: undefined,
      scenarioIds: [],
    })
  })

  it('parses --interactive / -i', () => {
    expect(parseArgs(['--interactive']).interactive).toBe(true)
    expect(parseArgs(['-i']).interactive).toBe(true)
  })

  it('parses --list / -l', () => {
    expect(parseArgs(['--list']).list).toBe(true)
    expect(parseArgs(['-l']).list).toBe(true)
  })

  it('parses --search with separate value', () => {
    expect(parseArgs(['--search', 'blocks']).search).toBe('blocks')
    expect(parseArgs(['-s', 'blocks']).search).toBe('blocks')
  })

  it('parses --search=value inline form', () => {
    expect(parseArgs(['--search=blocks']).search).toBe('blocks')
  })

  it('collects positional scenario ids', () => {
    expect(parseArgs(['rich-text-blocks', 'full']).scenarioIds).toEqual([
      'rich-text-blocks',
      'full',
    ])
  })
})

describe('filterScenarios', () => {
  const scenarios: LiveE2EScenario[] = [
    makeScenario({ id: 'rich-text-blocks', title: 'Rich Text Blocks', keywords: ['markdown'] }),
    makeScenario({ id: 'full', title: 'Full Live E2E', keywords: ['mention', 'probe'] }),
    makeScenario({
      id: 'no-workspace-chat',
      title: 'No-Workspace Chat',
      description: 'General knowledge question',
      keywords: ['chat'],
    }),
  ]

  it('matches by id substring', () => {
    const result = filterScenarios(scenarios, 'workspace')
    expect(result.map((s) => s.id)).toEqual(['no-workspace-chat'])
  })

  it('matches by title case-insensitively', () => {
    const result = filterScenarios(scenarios, 'RICH TEXT')
    expect(result.map((s) => s.id)).toEqual(['rich-text-blocks'])
  })

  it('matches by keyword', () => {
    const result = filterScenarios(scenarios, 'probe')
    expect(result.map((s) => s.id)).toEqual(['full'])
  })

  it('matches by description', () => {
    const result = filterScenarios(scenarios, 'general knowledge')
    expect(result.map((s) => s.id)).toEqual(['no-workspace-chat'])
  })

  it('returns empty array when nothing matches', () => {
    expect(filterScenarios(scenarios, 'zzz-no-match')).toEqual([])
  })
})

describe('resolveByIds', () => {
  const scenarios: LiveE2EScenario[] = [
    makeScenario({ id: 'rich-text-blocks', keywords: ['markdown'] }),
    makeScenario({ id: 'full', keywords: ['mention'] }),
    makeScenario({ id: 'slash-commands', keywords: ['commands'] }),
  ]

  it('resolves exact ids', () => {
    const result = resolveByIds(scenarios, ['full', 'slash-commands'])
    expect(result.map((s) => s.id)).toEqual(['full', 'slash-commands'])
  })

  it('resolves partial id match', () => {
    const result = resolveByIds(scenarios, ['rich'])
    expect(result.map((s) => s.id)).toEqual(['rich-text-blocks'])
  })

  it('resolves by keyword', () => {
    const result = resolveByIds(scenarios, ['markdown'])
    expect(result.map((s) => s.id)).toEqual(['rich-text-blocks'])
  })

  it('deduplicates when the same scenario matches multiple args', () => {
    const result = resolveByIds(scenarios, ['rich-text-blocks', 'markdown'])
    expect(result.map((s) => s.id)).toEqual(['rich-text-blocks'])
  })

  it('throws for unresolvable id', () => {
    expect(() => resolveByIds(scenarios, ['nonexistent'])).toThrow(
      'No scenario matching "nonexistent"',
    )
  })
})
