import type { IMAdapter } from '@/im/IMAdapter.ts'

export interface Application {
  start(): Promise<void>
  stop(): Promise<void>
  adapters: IMAdapter[]
}
