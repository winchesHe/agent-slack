import { describe, expect, it, vi } from 'vitest'
import { emitSyntheticFailed } from './emitSyntheticFailed.ts'
import type { EventSink } from '@/im/types.ts'

describe('emitSyntheticFailed', () => {
  it('emits lifecycle failed with message', async () => {
    const onEvent = vi.fn(async () => {})
    const sink: EventSink = {
      onEvent,
      finalize: async () => {},
      terminalPhase: undefined,
    }

    await emitSyntheticFailed(sink, 'boom')

    expect(onEvent).toHaveBeenCalledWith({
      type: 'lifecycle',
      phase: 'failed',
      error: { message: 'boom' },
    })
  })
})
