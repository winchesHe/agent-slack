export type ImProvider = 'slack' | 'wechat'

export interface IMAdapter {
  readonly id: ImProvider
  start(): Promise<void>
  stop(): Promise<void>
}
