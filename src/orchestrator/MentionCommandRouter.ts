import type { CoreMessage } from 'ai'
import type { InboundMessage } from '@/im/types.ts'
import type { Session } from '@/store/SessionStore.ts'
import type { ContextCompactor, ManualCompactResult } from './ContextCompactor.ts'

export type MentionCommand = 'compact'

export interface MentionCommandExecutionArgs {
  command: MentionCommand
  input: InboundMessage
  session: Session
  history: CoreMessage[]
}

export type MentionCommandExecutionResult = ManualCompactResult

export interface MentionCommandRouter {
  match(text: string): MentionCommand | undefined
  execute(args: MentionCommandExecutionArgs): Promise<MentionCommandExecutionResult>
}

export interface MentionCommandRouterDeps {
  compactor: ContextCompactor
}

const COMPACT_COMMANDS = new Set([
  '/compact',
  'compact',
  '压缩上下文',
  '压缩当前上下文',
  '帮我压缩上下文',
  '帮我压缩当前上下文',
  '请帮我压缩上下文',
  '请帮我压缩当前上下文',
])

function normalizeCommandText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function createMentionCommandRouter(deps: MentionCommandRouterDeps): MentionCommandRouter {
  return {
    match(text) {
      const normalized = normalizeCommandText(text)
      return COMPACT_COMMANDS.has(normalized) ? 'compact' : undefined
    },

    async execute(args) {
      if (args.command === 'compact') {
        return deps.compactor.manualCompact({
          session: args.session,
          history: args.history,
          trigger: 'mention_command',
          userId: args.input.userId,
        })
      }

      const exhaustive: never = args.command
      return exhaustive
    },
  }
}
