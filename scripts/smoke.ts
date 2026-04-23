import 'dotenv/config'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAiSdkExecutor } from '@/agent/AiSdkExecutor.ts'
import { buildBuiltinTools } from '@/agent/tools/index.ts'
import { createSelfImproveCollector } from '@/agent/tools/selfImprove.collector.ts'
import { createSelfImproveGenerator } from '@/agent/tools/selfImprove.generator.ts'
import { createConfirmBridge } from '@/im/slack/ConfirmBridge.ts'
import { createMemoryStore } from '@/store/MemoryStore.ts'
import { resolveWorkspacePaths } from '@/workspace/paths.ts'
import { createLogger } from '@/logger/logger.ts'
import { createRedactor } from '@/logger/redactor.ts'

async function main(): Promise<void> {
  const baseURL = process.env.LITELLM_BASE_URL
  const apiKey = process.env.LITELLM_API_KEY
  const model = process.env.SMOKE_MODEL ?? process.env.AGENT_MODEL ?? 'gpt-5.4'
  if (!baseURL || !apiKey) throw new Error('需要 LITELLM_BASE_URL 和 LITELLM_API_KEY')

  const logger = createLogger({ level: 'debug', redactor: createRedactor([apiKey]) })
  const paths = resolveWorkspacePaths(process.cwd())
  const memoryStore = createMemoryStore(paths)
  const selfImproveCollector = createSelfImproveCollector({ paths, logger })
  const selfImproveGenerator = createSelfImproveGenerator()
  const confirmBridge = createConfirmBridge({ logger })

  const provider = createOpenAICompatible({ baseURL, apiKey, name: 'litellm' })
  const exec = createAiSdkExecutor({
    model: provider.chatModel(model),
    tools: buildBuiltinTools(
      { cwd: process.cwd(), logger },
      { memoryStore, selfImproveCollector, selfImproveGenerator, confirmBridge, paths, logger },
    ),
    maxSteps: 10,
    logger,
    modelName: model,
  })

  const ctrl = new AbortController()
  for await (const e of exec.execute({
    systemPrompt: '你是个代码助手。可以用工具查看仓库。',
    messages: [
      {
        role: 'user',
        content: '用 bash 看一下当前目录有什么（ls -la），然后用一句话总结。',
      },
    ],
    abortSignal: ctrl.signal,
  })) {
    if (e.type === 'assistant-message') process.stdout.write(e.text)
    else if (e.type === 'activity-state') {
      if (e.state.clear) continue
      if (e.state.newToolCalls && e.state.newToolCalls.length > 0) {
        logger.info('tool_calls', e.state.newToolCalls)
      }
      if (e.state.reasoningTail) {
        logger.info('reasoning', e.state.reasoningTail)
      }
    } else if (e.type === 'usage-info') logger.info('\n--- usage ---', e.usage)
    else if (e.type === 'lifecycle' && e.phase === 'completed') {
      logger.info('\n--- done ---', { finalMessages: e.finalMessages.length })
    } else if (e.type === 'lifecycle' && e.phase === 'failed') {
      logger.error('stream error', e.error)
    }
  }
}

main().catch((err: unknown) => {
  process.exitCode = 1
  process.stderr.write(String(err) + '\n')
})
