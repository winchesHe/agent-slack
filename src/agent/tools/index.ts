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
  return {
    bash: bashTool(ctx),
    edit_file: editFileTool(ctx),
    save_memory: saveMemoryTool(ctx, { memoryStore: deps.memoryStore }),
    self_improve_collect: selfImproveCollectTool(ctx, {
      collector: deps.selfImproveCollector,
    }),
    self_improve_confirm: selfImproveConfirmTool(ctx, {
      generator: deps.selfImproveGenerator,
      ...(deps.selfImproveSemanticDedup ? { semanticDedup: deps.selfImproveSemanticDedup } : {}),
      paths: deps.paths,
      logger: deps.logger,
    }),
    ask_confirm: askConfirmTool(ctx, {
      bridge: deps.confirmBridge,
      logger: deps.logger,
    }),
  }
}

export type { ToolContext }
