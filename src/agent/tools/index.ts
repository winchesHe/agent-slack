import type { ToolSet } from 'ai'
import type { MemoryStore } from '@/store/MemoryStore.ts'
import type { WorkspacePaths } from '@/workspace/paths.ts'
import type { Logger } from '@/logger/logger.ts'
import type { ConfirmBridge } from '@/im/slack/ConfirmBridge.ts'
import { bashTool, type ToolContext } from './bash.ts'
import { editFileTool } from './editFile.ts'
import { saveMemoryTool } from './saveMemory.ts'
import { selfImproveCollectTool } from './selfImproveCollect.ts'
import { selfImproveConfirmTool } from './selfImproveConfirm.ts'
import { askConfirmTool } from './askConfirm.ts'
import type { SelfImproveCollector } from '@/agents/selfImprove/collectorAgent.ts'
import type { SelfImproveGenerator } from '@/agents/selfImprove/generatorAgent.ts'
import type { SemanticDedup } from '@/agents/selfImprove/semanticDedupAgent.ts'

export interface BuiltinToolDeps {
  memoryStore: MemoryStore
  selfImproveCollector: SelfImproveCollector
  selfImproveGenerator: SelfImproveGenerator
  selfImproveSemanticDedup?: SemanticDedup
  confirmBridge: ConfirmBridge
  paths: WorkspacePaths
  logger: Logger
}

export function buildBuiltinTools(ctx: ToolContext, deps: BuiltinToolDeps): ToolSet {
  const tools: ToolSet = {
    bash: bashTool(ctx),
    edit_file: editFileTool(ctx),
    save_memory: saveMemoryTool(ctx, { memoryStore: deps.memoryStore }),
    self_improve_collect: selfImproveCollectTool(ctx, {
      collector: deps.selfImproveCollector,
    }),
  }
  // 仅在 ctx.confirm 存在时注入 confirm 系工具：避免无 IM 上下文（或非交互场景）下
  // 把这两个工具暴露给模型；过去依赖运行时降级，不利于工具列表一致性。
  if (ctx.confirm) {
    tools.ask_confirm = askConfirmTool(ctx, {
      bridge: deps.confirmBridge,
      logger: deps.logger,
    })
    tools.self_improve_confirm = selfImproveConfirmTool(ctx, {
      generator: deps.selfImproveGenerator,
      ...(deps.selfImproveSemanticDedup ? { semanticDedup: deps.selfImproveSemanticDedup } : {}),
      paths: deps.paths,
      logger: deps.logger,
    })
  }
  return tools
}

export type { ToolContext }
