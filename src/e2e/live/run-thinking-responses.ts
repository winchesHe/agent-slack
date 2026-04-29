import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { consola } from 'consola'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import {
  createLiveE2EContext,
  delay,
  findReplyContaining,
  findUsageMessage,
  hasReaction,
  hasUsageMessage,
  waitForThread,
  writeScenarioResult,
} from './scenario-utils.ts'

interface ThinkingResponsesResult {
  assistantReplyText?: string
  failureMessage?: string
  matched: {
    assistantReplied: boolean
    doneReactionObserved: boolean
    usageObserved: boolean
    // (N thinking) 段出现 ⟹ 链路正确：
    //   reasoning_tokens > 0
    //   ⟹ ai-sdk 从 OpenAI /responses finish chunk providerMetadata.openai.reasoningTokens 提取到了非零值
    //   ⟹ /responses 端点确实被调用、reasoning effort 透传成功、ai-sdk 解码正确
    //   ⟹ AiSdkExecutor.updateUsage 累加成功
    //   ⟹ SlackRenderer.formatUsageLine 渲染段位正确
    // 无需在 e2e 进程内 monkey-patch globalThis.fetch（在含 Slack/axios 的复杂 import 链下不可靠）；
    // wire 级字段（baseURL / store:false / reasoning effort/summary）由 createApplication 单测覆盖：
    //   src/application/createApplication.test.ts 'config.agent.provider=openai-responses → ...'
    thinkingTailObserved: boolean
    // progress block 中间消息会被最终态覆盖，e2e 跑完无法直接观察 Slack UI；
    // 改为 grep daemon log（SlackRenderer 在 reasoningTail 出现时会写一条
    // `progress reasoning emoji rendered: :fluent-thinking-3d:` info 级日志），
    // 验证 reasoning summary 流真触发了 progress block 的 emoji 渲染路径。
    progressEmojiRendered: boolean
  }
  passed: boolean
  runId: string
  rootMessageTs?: string
  usageText?: string
}

// 用 cwd workspace 临时改 config.yaml 而不是创建 tmp workspace：
// tmp workspace 模式在 socket mode + sessions/memory/daemon 路径下不稳定，
// 实测 Slack adapter 启动后收不到 mention。cwd 模式是 basic-reply 的成熟路径。
const cwdConfigPath = path.join(process.cwd(), '.agent-slack', 'config.yaml')

async function rewriteCwdConfig(): Promise<{ original: string }> {
  const original = await fs.readFile(cwdConfigPath, 'utf8')
  // 用 reasoningEffort=low 加快 e2e 周转。验证目标只要 reasoning_tokens > 0：
  // low / medium / high 任一档位都会触发 reasoning，足以证明链路通。
  const next = [
    'agent:',
    '  provider: openai-responses',
    '  model: gpt-5.4',
    '  responses:',
    // medium 是 spec 默认。low 在简单 prompt 下经常 reasoning_tokens=0；medium 更稳定地触发 reasoning 报告。
    '    reasoningEffort: medium',
    // 'detailed' 强制模型输出 reasoning summary 文本流（'auto' 让模型自决，简单题常常不输出 summary
    // 即便有 reasoning_tokens > 0）。e2e 需要 summary 流来验证 progress block 的 :fluent-thinking-3d:
    // emoji 渲染路径被触发。
    '    reasoningSummary: detailed',
    'skills:',
    '  enabled:',
    '    - "*"',
    'im:',
    '  provider: slack',
    '  slack:',
    '    resolveChannelName: true',
    '',
  ].join('\n')
  await fs.writeFile(cwdConfigPath, next, 'utf8')
  return { original }
}

async function restoreCwdConfig(original: string): Promise<void> {
  await fs.writeFile(cwdConfigPath, original, 'utf8')
}

async function runOneAttempt(
  ctx: Awaited<ReturnType<typeof createLiveE2EContext>>,
  runId: string,
  result: ThinkingResponsesResult,
  attempt: number,
): Promise<void> {
  const triggerText = [
    `<@${ctx.botUserId}> THINKING_E2E ${runId} attempt=${attempt}`,
    // 让 LLM 必须做非平凡推理触发可观测 reasoning_tokens。
    '逐步思考再回答：从 1 到 100 的所有偶数中，所有不能被 4 整除的数的总和是多少？',
    `回复必须以 "THINKING_OK ${runId}: " 开头，紧跟一个数字，无其他文本。`,
  ].join('\n')
  const rootMessage = await ctx.triggerClient.postMessage({
    channel: ctx.channelId,
    text: triggerText,
    unfurl_links: false,
    unfurl_media: false,
  })
  result.rootMessageTs = rootMessage.ts

  await waitForThread(ctx, rootMessage.ts, async (messages) => {
    const reply = findReplyContaining(messages, rootMessage.ts, `THINKING_OK ${runId}`)
    if (reply) {
      result.assistantReplyText = reply.text ?? ''
      result.matched.assistantReplied = true
    }
    result.matched.usageObserved = hasUsageMessage(messages, rootMessage.ts)
    const usage = findUsageMessage(messages, rootMessage.ts)
    if (typeof usage?.text === 'string') {
      result.usageText = usage.text
    }
    result.matched.thinkingTailObserved = /\(\d+(?:\.\d+)?k? thinking\)/.test(usage?.text ?? '')
    result.matched.doneReactionObserved = await hasReaction(
      ctx.botClient,
      ctx.channelId,
      rootMessage.ts,
      'white_check_mark',
    )

    return (
      result.matched.assistantReplied &&
      result.matched.usageObserved &&
      result.matched.thinkingTailObserved &&
      result.matched.doneReactionObserved
    )
  })
}

// 事后 grep daemon log 看 reasoning emoji 渲染日志是否在 e2e 时间窗内出现过。
// daemon log 行格式：`[2026-04-29T03:25:54.930Z] [info] [slack:render] progress reasoning emoji rendered: :fluent-thinking-3d: { tailPrefix: "..." }`
async function logHasProgressEmojiSince(startedAt: number): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)
  const logFile = path.join(process.cwd(), '.agent-slack', 'logs', `agent-${today}.log`)
  let raw: string
  try {
    raw = await fs.readFile(logFile, 'utf8')
  } catch {
    return false
  }
  for (const line of raw.split('\n')) {
    const tsMatch = line.match(/^\[([^\]]+)\]/)
    if (!tsMatch) continue
    const t = Date.parse(tsMatch[1]!)
    if (Number.isFinite(t) && t < startedAt) continue
    if (line.includes(':fluent-thinking-3d:')) return true
  }
  return false
}

async function main(): Promise<void> {
  const runId = randomUUID()
  const result: ThinkingResponsesResult = {
    matched: {
      assistantReplied: false,
      doneReactionObserved: false,
      usageObserved: false,
      thinkingTailObserved: false,
      progressEmojiRendered: false,
    },
    passed: false,
    runId,
  }
  const startedAt = Date.now()

  const { original: originalConfig } = await rewriteCwdConfig()

  let ctx: Awaited<ReturnType<typeof createLiveE2EContext>> | undefined
  let caughtError: unknown
  try {
    ctx = await createLiveE2EContext(runId)
    await ctx.application.start()
    await delay(3_000)

    // LiteLLM 网关在 /responses 端点带 reasoning_summary 流式时偶发延迟（实测可达 2 分钟无响应），
    // 用至多 2 次 trigger 增强可靠性。
    const maxAttempts = 2
    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await runOneAttempt(ctx, runId, result, attempt)
        if (
          result.matched.assistantReplied &&
          result.matched.usageObserved &&
          result.matched.thinkingTailObserved &&
          result.matched.doneReactionObserved
        ) {
          break
        }
      } catch (error) {
        lastError = error
        consola.warn(`[attempt ${attempt}/${maxAttempts}] error: ${(error as Error).message}`)
      }
      if (attempt < maxAttempts) {
        consola.info(`[attempt ${attempt}/${maxAttempts}] not all matched, retrying after 5s…`)
        await delay(5_000)
        // 重置 matched 状态，让下次 trigger 干净评估
        result.matched.assistantReplied = false
        result.matched.doneReactionObserved = false
        result.matched.usageObserved = false
        result.matched.thinkingTailObserved = false
      }
    }

    if (lastError && !result.matched.assistantReplied) {
      throw lastError
    }

    // daemon log 是异步 fs.appendFile，给点时间让它 flush 完。
    await delay(500)
    result.matched.progressEmojiRendered = await logHasProgressEmojiSince(startedAt)

    assertResult(result)
    result.passed = true
    consola.info('Live thinking-responses E2E passed.')
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeScenarioResult('thinking-responses', result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    if (ctx) {
      await ctx.application.stop().catch((error) => {
        consola.error('Failed to stop application:', error)
      })
    }
    // 无论成败都还原 cwd config.yaml
    await restoreCwdConfig(originalConfig).catch((error) => {
      consola.error('Failed to restore config.yaml:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

function assertResult(result: ThinkingResponsesResult): void {
  const failures: string[] = []
  if (!result.matched.assistantReplied) failures.push('assistant reply not observed')
  if (!result.matched.doneReactionObserved) failures.push('done reaction not observed')
  if (!result.matched.usageObserved) failures.push('usage message not observed')
  if (!result.matched.thinkingTailObserved) {
    failures.push('(N thinking) segment not in usage line')
  }
  if (!result.matched.progressEmojiRendered) {
    failures.push(':fluent-thinking-3d: emoji render log not found in daemon log')
  }
  if (failures.length > 0) {
    throw new Error(`Live thinking-responses E2E failed: ${failures.join('; ')}`)
  }
}

export const scenario: LiveE2EScenario = {
  id: 'thinking-responses',
  title: 'Thinking via Responses',
  description:
    'Mention the bot with provider=openai-responses; verify reasoning tail (N thinking) appears in usage line, ' +
    'which indirectly proves /responses endpoint, reasoning effort transit, and ai-sdk decoding are all wired correctly.',
  keywords: ['thinking', 'reasoning', 'openai', 'responses'],
  run: main,
}

runDirectly(scenario)
