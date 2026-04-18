export interface IMAdapter {
  readonly id: 'slack' | 'telegram'
  start(): Promise<void>
  stop(): Promise<void>
}
