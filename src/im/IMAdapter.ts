export type ImProvider = 'slack' | 'wechat' | 'telegram'

export interface IMAdapter {
  readonly id: ImProvider
  start(): Promise<void>
  stop(): Promise<void>
}
