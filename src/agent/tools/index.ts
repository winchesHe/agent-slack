import type { ToolSet } from 'ai'
import type { MemoryStore } from '@/store/MemoryStore.ts'
import type { WorkspacePaths } from '@/workspace/paths.ts'
import type { Logger } from '@/logger/logger.ts'
import { bashTool, type ToolContext } from './bash.ts'
import { editFileTool } from './editFile.ts'
import { saveMemoryTool } from './saveMemory.ts'
import { selfImproveCollectTool } from './selfImproveCollect.ts'
import { selfImproveConfirmTool } from './selfImproveConfirm.ts'
import type { SelfImproveCollector } from './selfImprove.collector.ts'
import type { SelfImproveGenerator } from './selfImprove.generator.ts'

export interface BuiltinToolDeps {
  memoryStore: MemoryStore
  selfImproveCollector: SelfImproveCollector
  selfImproveGenerator: SelfImproveGenerator
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
      paths: deps.paths,
      logger: deps.logger,
    }),
  }
}

export type { ToolContext }
