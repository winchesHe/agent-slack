import 'dotenv/config'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAiSdkExecutor } from '@/agent/AiSdkExecutor.ts'
import { buildBuiltinTools } from '@/agent/tools/index.ts'
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

  const provider = createOpenAICompatible({ baseURL, apiKey, name: 'litellm' })
  const exec = createAiSdkExecutor({
    model: provider.chatModel(model),
    tools: buildBuiltinTools({ cwd: process.cwd(), logger }, { memoryStore }),
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
    if (e.type === 'text_delta') process.stdout.write(e.text)
    else if (e.type === 'tool_call_start') logger.info(`tool_call: ${e.toolName}`, e.input)
    else if (e.type === 'tool_call_end')
      logger.info(`tool_end: ${e.toolName}`, { isError: e.isError })
    else if (e.type === 'done') logger.info('\n--- done ---', e.totalUsage)
    else if (e.type === 'error') logger.error('stream error', e.error)
  }
}

main().catch((err: unknown) => {
  process.exitCode = 1
  process.stderr.write(String(err) + '\n')
})
