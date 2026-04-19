// 进程态文案池，跨 executor / sink / renderer 共享。
export const STATUS = {
  thinking: '思考中…',
  composing: '回复中…',
  reasoning: '推理中…',
} as const

// Slack loading_messages 使用的中文轮换文案。
export const LOADING_POOL = [
  '正在组织思路…',
  '梳理脉络中…',
  '权衡各种角度…',
  '追溯问题根源…',
  '勾勒答案轮廓…',
  '编织片段中…',
  '让答案浮现…',
  '换个角度看看…',
  '仔细品味问题…',
  '寻找合适的措辞…',
  '把碎片连成整体…',
  '专注于关键所在…',
  '在可能性中漫游…',
  '层层构建理解…',
  '感知问题轮廓…',
  '小心地落子…',
  '让思绪沉淀片刻…',
  '从静默中汲取…',
] as const

// 返回洗牌后的新数组，避免原地修改共享常量。
export function getShuffledLoadingMessages(count = 8): string[] {
  const shuffled = [...LOADING_POOL]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!]
  }

  return shuffled.slice(0, Math.min(count, shuffled.length))
}

export const TOOL_PHRASE = {
  input: (name: string) => `准备调用 ${name}…`,
  running: (name: string) => `正在 ${name}…`,
} as const
