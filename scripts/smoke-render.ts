import type { WebClient } from '@slack/web-api'
import type { Logger } from '@/logger/logger.ts'
import { createSlackRenderer } from '@/im/slack/SlackRenderer.ts'
import { STATUS, getShuffledLoadingMessages } from '@/im/slack/thinking-messages.ts'

// 统一写 stdout，方便 smoke 输出保持一行一个事件。
function writeLine(line: string): void {
  process.stdout.write(`${line}\n`)
}

// 截断过长 payload，避免观测输出被大段 blocks 淹没。
function formatValue(value: unknown): string {
  const json = JSON.stringify(value)
  return json.length > 220 ? `${json.slice(0, 220)}...` : json
}

// smoke logger 直接把 warn/info 打到终端，便于观察 safeRender 行为。
function createSmokeLogger(tag = 'smoke'): Logger {
  return {
    debug: (message, meta) => writeLine(`[debug] [${tag}] ${message}${meta ? ` ${formatValue(meta)}` : ''}`),
    info: (message, meta) => writeLine(`[info] [${tag}] ${message}${meta ? ` ${formatValue(meta)}` : ''}`),
    warn: (message, meta) => writeLine(`[warn] [${tag}] ${message}${meta ? ` ${formatValue(meta)}` : ''}`),
    error: (message, meta) =>
      writeLine(`[error] [${tag}] ${message}${meta ? ` ${formatValue(meta)}` : ''}`),
    withTag: (nextTag) => createSmokeLogger(nextTag),
  }
}

// 用纯 mock WebClient 记录 renderer 调用了哪些 Slack API，不产生真实副作用。
function createMockWebClient(): WebClient {
  let messageIndex = 0

  const record =
    (method: string, resultFactory?: () => { ok: true; ts?: string }) =>
    async (args: unknown): Promise<{ ok: true; ts?: string }> => {
      writeLine(`→ ${method} ${formatValue(args)}`)
      return resultFactory ? resultFactory() : { ok: true }
    }

  return {
    reactions: {
      add: record('reactions.add'),
    },
    chat: {
      postMessage: record('chat.postMessage', () => {
        messageIndex += 1
        return { ok: true, ts: `ts-${messageIndex}` }
      }),
      update: record('chat.update'),
      delete: record('chat.delete'),
    },
    assistant: {
      threads: {
        setStatus: record('assistant.threads.setStatus'),
      },
    },
  } as unknown as WebClient
}

async function runChunk2Smoke(): Promise<void> {
  writeLine('====== [CHUNK 2] SlackRenderer smoke ======')

  const renderer = createSlackRenderer({ logger: createSmokeLogger() })
  {
    // done path：验证 ack、状态条、progress、usage、完成 reaction 的组合。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] done path')
    await renderer.addAck(web, 'C1', 'src-ts')
    await renderer.setStatus(web, 'C1', 't1', STATUS.thinking, getShuffledLoadingMessages(4))

    const progressTs = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '正在 read_file…',
      activities: ['正在 read_file…'],
      toolHistory: new Map([['read_file', 1]]),
    })
    writeLine(`[CHUNK 2] done path progress ts = ${progressTs ?? 'undefined'}`)

    if (progressTs) {
      await renderer.finalizeProgressMessageDone(
        web,
        'C1',
        't1',
        progressTs,
        new Map([
          ['read_file', 2],
          ['bash', 1],
        ]),
      )
    }

    await renderer.postSessionUsage(web, 'C1', 't1', {
      durationMs: 11_200,
      totalCostUSD: 0.0676,
      modelUsage: [
        {
          model: 'sonnet-4-6',
          inputTokens: 1000,
          outputTokens: 200,
          cachedInputTokens: 620,
          cacheHitRate: 0.62,
        },
      ],
    })
    await renderer.clearStatus(web, 'C1', 't1')
    await renderer.addDone(web, 'C1', 'src-ts')
  }

  {
    // reply path：验证 markdown reply 与首块 workspaceLabel 注入。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] reply path')
    await renderer.postThreadReply(web, 'C1', 't1', '**hello** _world_', {
      workspaceLabel: 'workspace: demo',
    })
  }

  {
    // stopped path：验证中止文案与 stop reaction，不混入其他终态。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] stopped path')
    const progressTs = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '正在 bash…',
      activities: ['正在 bash…', '命令执行中…'],
      toolHistory: new Map([
        ['read_file', 2],
        ['bash', 1],
      ]),
      reasoningTail: '正在整理命令输出摘要',
    })
    writeLine(`[CHUNK 2] stopped path progress ts = ${progressTs ?? 'undefined'}`)
    if (progressTs) {
      await renderer.finalizeProgressMessageStopped(web, 'C1', 't1', progressTs)
    }
    await renderer.clearStatus(web, 'C1', 't1')
    await renderer.addStopped(web, 'C1', 'src-ts')
  }

  {
    // error path：验证错误 finalize 和 error reaction。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] error path')
    const progressTs = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '正在 deploy…',
      activities: ['正在 deploy…'],
      toolHistory: new Map([['deploy', 1]]),
    })
    writeLine(`[CHUNK 2] error path progress ts = ${progressTs ?? 'undefined'}`)
    if (progressTs) {
      await renderer.finalizeProgressMessageError(web, 'C1', 't1', progressTs, 'boom')
    }
    await renderer.addError(web, 'C1', 'src-ts')
  }

  {
    // delete path：单独验证 progress 删除动作。
    const web = createMockWebClient()
    writeLine('[CHUNK 2] delete path')
    const progressTs = await renderer.upsertProgressMessage(web, 'C1', 't1', {
      status: '准备清理 progress…',
      activities: ['准备清理 progress…'],
      toolHistory: new Map([['cleanup', 1]]),
    })
    writeLine(`[CHUNK 2] delete path progress ts = ${progressTs ?? 'undefined'}`)
    if (progressTs) {
      await renderer.deleteProgressMessage(web, 'C1', 't1', progressTs)
    }
  }
}

runChunk2Smoke().catch((error: unknown) => {
  process.stderr.write(String(error) + '\n')
  process.exitCode = 1
})
