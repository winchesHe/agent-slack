import type { IMAdapter } from '@/im/IMAdapter.ts'
import type { AbortRegistry } from '@/orchestrator/AbortRegistry.ts'

export interface Application {
  start(): Promise<void>
  stop(): Promise<void>
  adapters: IMAdapter[]
  abortRegistry: AbortRegistry<string>
}
