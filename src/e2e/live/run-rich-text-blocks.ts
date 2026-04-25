import './load-e2e-env.ts'

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { consola } from 'consola'
import { createApplication } from '@/application/createApplication.ts'
import type { Application } from '@/application/types.ts'
import type { LiveE2EScenario } from './scenario.ts'
import { runDirectly } from './scenario.ts'
import { SlackApiClient } from './slack-api-client.ts'

interface RichTextBlocksResult {
  assistantReplyText?: string
  assistantReplyTs?: string
  blocks?: unknown[]
  botUserId: string
  channelId: string
  failureMessage?: string
  matched: {
    assistantReplied: boolean
    hasBlocks: boolean
    hasRichTextOrSectionBlock: boolean
    replyContainsMarker: boolean
  }
  passed: boolean
  rootMessageTs?: string
  runId: string
}

async function main(): Promise<void> {
  const channelId = requireEnv('SLACK_E2E_CHANNEL_ID')
  const triggerUserToken = requireEnv('SLACK_E2E_TRIGGER_USER_TOKEN')
  const timeoutMs = parseTimeoutMs(process.env.SLACK_E2E_TIMEOUT_MS)
  const runId = randomUUID()
  const triggerClient = new SlackApiClient(triggerUserToken)
  const botClient = new SlackApiClient(requireEnv('SLACK_BOT_TOKEN'))
  const botIdentity = await botClient.authTest()

  const result: RichTextBlocksResult = {
    botUserId: botIdentity.user_id,
    channelId,
    matched: {
      assistantReplied: false,
      hasBlocks: false,
      hasRichTextOrSectionBlock: false,
      replyContainsMarker: false,
    },
    passed: false,
    runId,
  }

  let application: Application | undefined
  let caughtError: unknown

  try {
    application = await createApplication({ workspaceDir: process.cwd() })
    await application.start()
    await delay(3_000)

    const prompt = [
      `<@${botIdentity.user_id}> RICH_TEXT_E2E ${runId}`,
      'Reply with exactly this markdown. Do not wrap it in a code fence:',
      `RICH_OK ${runId}`,
      '',
      '**加粗文字** 和 _斜体文字_',
      '',
      '```ts',
      'const name = "agent-slack"',
      '```',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '> 引用中文内容',
      '',
      'Do not add anything else. Do not use tools.',
    ].join('\n')

    const rootMessage = await triggerClient.postMessage({
      channel: channelId,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    })
    result.rootMessageTs = rootMessage.ts
    consola.info('Posted root message: %s', rootMessage.ts)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: channelId,
        inclusive: true,
        limit: 50,
        ts: rootMessage.ts,
      })

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === rootMessage.ts) {
          continue
        }

        const text = typeof message.text === 'string' ? message.text : ''
        if (!text.includes(`RICH_OK ${runId}`)) {
          continue
        }

        result.assistantReplyText = text
        result.assistantReplyTs = message.ts ?? ''
        result.matched.assistantReplied = true
        result.matched.replyContainsMarker = true

        const blocks = message.blocks ?? []
        result.blocks = blocks
        result.matched.hasBlocks = blocks.length > 0
        result.matched.hasRichTextOrSectionBlock = blocks.some(
          (block) => block.type === 'rich_text' || block.type === 'section',
        )
      }

      if (result.matched.assistantReplied) {
        break
      }

      await delay(2_500)
    }

    await writeResult(result)
    assertResult(result)
    result.passed = true
    await writeResult(result)

    consola.info('Live rich text blocks E2E passed.')
    consola.info('Root thread: %s', result.rootMessageTs)
    consola.info('Assistant reply: %s', result.assistantReplyTs)
    consola.info('Blocks found: %d', result.blocks?.length ?? 0)
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error)
    caughtError = error
  } finally {
    await writeResult(result).catch((error) => {
      consola.error('Failed to persist result:', error)
    })
    await application?.stop().catch((error) => {
      consola.error('Failed to stop application:', error)
    })
  }

  if (caughtError) {
    throw caughtError
  }
}

function assertResult(result: RichTextBlocksResult): void {
  const failures: string[] = []

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout')
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`reply does not contain expected marker "RICH_OK ${result.runId}"`)
  }
  if (!result.matched.hasBlocks) {
    failures.push('reply has no blocks; expected markdownToBlocks output')
  }
  if (!result.matched.hasRichTextOrSectionBlock) {
    failures.push('reply blocks do not contain rich_text or section type')
  }

  if (failures.length > 0) {
    throw new Error(`Live rich text blocks E2E failed: ${failures.join('; ')}`)
  }
}

async function writeResult(result: RichTextBlocksResult): Promise<void> {
  const resultPath = process.env.SLACK_E2E_RESULT_PATH?.trim() || '.agent-slack/e2e/result.json'
  const absolutePath = path.resolve(process.cwd(), resultPath).replace(
    /result\.json$/,
    'rich-text-blocks-result.json',
  )
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

function requireEnv(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) {
    throw new Error(`缺少环境变量 ${key}`)
  }
  return value
}

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? '120000')
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`SLACK_E2E_TIMEOUT_MS 必须是正整数毫秒值，当前值：${value}`)
  }
  return Math.floor(parsed)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export const scenario: LiveE2EScenario = {
  id: 'rich-text-blocks',
  title: 'Rich Text Blocks',
  description:
    'Mention the bot with a request for markdown-formatted output and verify the reply uses Slack rich text or section blocks.',
  keywords: ['rich-text', 'blocks', 'markdown', 'formatting', 'slack'],
  run: main,
}

runDirectly(scenario)
