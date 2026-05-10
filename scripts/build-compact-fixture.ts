import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 确定性 PRNG（mulberry32），保证每次生成 byte-identical
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0x5a17c0
const TARGET_CHARS = 1_000_000
const FILE_TARGET = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'compact',
  'large-history-1m.jsonl',
)

const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation',
]

function randomWord(rng: () => number): string {
  return LOREM_WORDS[Math.floor(rng() * LOREM_WORDS.length)]!
}

function paragraph(rng: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(randomWord(rng))
  return out.join(' ')
}

function uuid(rng: () => number): string {
  // 确定性 UUID（基于 mulberry32），格式合规但不是真随机
  const hex = (n: number) =>
    Math.floor(rng() * 16 ** n)
      .toString(16)
      .padStart(n, '0')
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`
}

interface CoreMsg {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string | unknown[]
}

function userMsg(rng: () => number): CoreMsg {
  return {
    id: uuid(rng),
    role: 'user',
    content: paragraph(rng, 80 + Math.floor(rng() * 40)),
  }
}

function assistantTextMsg(rng: () => number): CoreMsg {
  return {
    id: uuid(rng),
    role: 'assistant',
    content: paragraph(rng, 100 + Math.floor(rng() * 60)),
  }
}

function assistantWithToolCallMsg(rng: () => number, toolCallId: string): CoreMsg {
  return {
    id: uuid(rng),
    role: 'assistant',
    content: [
      { type: 'text', text: paragraph(rng, 30) },
      {
        type: 'tool-call',
        toolCallId,
        toolName: 'bash',
        // ai-sdk v4 CoreMessage schema 要求 tool-call 用 `args`（不是 `input`）。
        args: { command: `echo ${paragraph(rng, 5)}` },
      },
    ],
  }
}

function toolResultMsg(rng: () => number, toolCallId: string, largeOutput = false): CoreMsg {
  const result = largeOutput
    ? paragraph(rng, 1500 + Math.floor(rng() * 500))
    : paragraph(rng, 100 + Math.floor(rng() * 50))
  return {
    id: uuid(rng),
    role: 'tool',
    // ai-sdk v4 toolResultPartSchema 要求 `toolName` 必填。
    content: [{ type: 'tool-result', toolCallId, toolName: 'bash', result }],
  }
}

async function main(): Promise<void> {
  const rng = mulberry32(SEED)
  const lines: string[] = []
  let totalChars = 0
  let toolCallSeq = 0

  while (totalChars < TARGET_CHARS) {
    // 模式：user → (assistant_text | assistant_with_tool → tool_result)
    lines.push(JSON.stringify(userMsg(rng)))
    if (rng() < 0.6) {
      // 60% 概率走 tool 配对
      const tcid = `tc_${toolCallSeq++}`
      lines.push(JSON.stringify(assistantWithToolCallMsg(rng, tcid)))
      lines.push(JSON.stringify(toolResultMsg(rng, tcid, rng() < 0.1)))
      // 10% 概率产出"大 tool_result"（~10K chars），模拟真实场景
    } else {
      lines.push(JSON.stringify(assistantTextMsg(rng)))
    }
    totalChars = lines.reduce((s, l) => s + l.length + 1, 0)
  }

  await writeFile(FILE_TARGET, lines.join('\n') + '\n', 'utf8')
  console.log(`Generated ${lines.length} lines, ${totalChars} chars → ${FILE_TARGET}`)
}

await main()
