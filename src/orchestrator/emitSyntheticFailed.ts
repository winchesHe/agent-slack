import type { EventSink } from '@/im/types.ts'

export async function emitSyntheticFailed(sink: EventSink, message: string): Promise<void> {
  // 内部异常统一走终态 lifecycle，避免旁路分叉。
  await sink.onEvent({
    type: 'lifecycle',
    phase: 'failed',
    error: { message },
  })
}
