import type { ToolSet } from 'ai'
import type { MemoryStore } from '@/store/MemoryStore.ts'
import { bashTool, type ToolContext } from './bash.ts'
import { editFileTool } from './editFile.ts'
import { saveMemoryTool } from './saveMemory.ts'

export function buildBuiltinTools(ctx: ToolContext, deps: { memoryStore: MemoryStore }): ToolSet {
  return {
    bash: bashTool(ctx),
    edit_file: editFileTool(ctx),
    save_memory: saveMemoryTool(ctx, { memoryStore: deps.memoryStore }),
  }
}

export type { ToolContext }
