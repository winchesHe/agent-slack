import type { CoreMessage } from 'ai'

// 参考 free-code services/compact/prompts.ts。9 章节 + <analysis>/<summary>
// 双 block 结构是 Anthropic compact 的高保真方案；NO_TOOLS 双重保护避免
// Sonnet 4.6 偶发的工具调用越界；不限制章节长度/要点数，按需展开。
const NO_TOOLS_PREAMBLE = `重要：仅以**纯文本**回应，不要调用任何工具。

- 不要使用 bash、edit_file、save_memory 或任何其他工具。
- 你已经在上面的对话中拥有了所需的全部上下文。
- 工具调用会被拒绝，本次任务将失败。
- 你的全部回应必须是纯文本：先一个 <analysis> 块，再一个 <summary> 块。

`

const ANALYSIS_INSTRUCTION = `在给出最终摘要前，把分析过程写在 <analysis> 标签里组织你的思路，确保覆盖所有要点。分析时：

1. 按时序分析对话的每条消息和每个段落。对于每段务必识别：
   - 用户的明确请求与意图
   - 你应对该请求的方法
   - 关键决策、技术概念与代码模式
   - 具体细节，例如：
     - 文件名
     - 完整代码片段
     - 函数签名
     - 文件编辑
   - 你遇到的错误以及如何修复
   - 特别注意用户给予的反馈，尤其是用户要求你换种做法时
2. 复核技术准确性与完整性，逐一覆盖每个必要元素。`

const COMPACT_BODY = `你的任务是给目前为止的对话生成一份**详细**摘要，特别关注用户的明确请求和你之前的动作。
该摘要应充分捕捉技术细节、代码模式与架构决策，使后续工作可以无损地继续。

${ANALYSIS_INSTRUCTION}

你的摘要应包含以下章节：

1. 用户主诉与意图：详细描述用户全部明确请求与意图。
2. 关键技术概念：列出讨论过的所有重要技术概念、技术与框架。
3. 涉及文件与代码段：枚举被读取/修改/创建的具体文件与代码段。特别关注最近的消息，**verbatim 完整 snippet**，并附该文件被读/改的原因摘要。
4. 错误与修复：列出全部错误及修复方式。特别关注用户的反馈——如果用户告诉你换种做法，必须保留。
5. 问题解决记录：记录已解决的问题与正在排查的事项。
6. 全部用户消息（非工具结果）：列出 thread 内**全部**用户消息，**不省略**——便于后续回看用户反馈与意图变化。
7. 待办事项：列出用户明确要求的待办。
8. 当前进展：详细描述本次摘要请求前正在做的事，特别关注最近的用户和 assistant 消息。包含文件名与代码片段。
9. 下一步建议：列出与最近工作直接相关的下一步。务必：与用户最近的明确请求一致；如果上一任务已结束，仅在用户明确要求时列下一步；不要擅自展开切线请求或重启已完成的旧任务。如果有下一步，**verbatim 引用最近对话**说明你被卡在哪里，避免任务漂移。

输出结构示例：

<example>
<analysis>
[你的思考过程，确保所有要点完整准确覆盖]
</analysis>

<summary>
1. 用户主诉与意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]
   - [...]

3. 涉及文件与代码段：
   - [文件名 1]
      - [该文件为何重要]
      - [所做改动摘要，如有]
      - [关键代码 snippet]
   - [文件名 2]
      - [关键代码 snippet]
   - [...]

4. 错误与修复：
    - [错误 1 详描]：
      - [如何修复]
      - [用户反馈，如有]
    - [...]

5. 问题解决记录：
   [已解决的问题与正在排查的事项]

6. 全部用户消息：
    - [详细的非工具结果用户消息]
    - [...]

7. 待办事项：
   - [任务 1]
   - [任务 2]
   - [...]

8. 当前进展：
   [当前工作的精确描述]

9. 下一步建议：
   [可选的下一步]

</summary>
</example>

请基于目前为止的对话给出你的摘要，遵循上述结构，确保精确与详尽。`

const NO_TOOLS_TRAILER = `

提醒：不要调用任何工具。仅以纯文本回应——一个 <analysis> 块，紧接一个 <summary> 块。工具调用会被拒绝，本次任务将失败。`

export const COMPACT_SYSTEM_PROMPT = NO_TOOLS_PREAMBLE + COMPACT_BODY + NO_TOOLS_TRAILER

function serializeMessages(messages: CoreMessage[]): string {
  return messages.map((message) => JSON.stringify(message)).join('\n')
}

export function buildCompactPrompt(input: { messages: CoreMessage[] }): string {
  // 不预截输入：超长时由 ContextCompactor 的 PTL retry 按 API round 砍头处理。
  const visibleTranscript = serializeMessages(input.messages)

  return `请压缩下面这段 agent-slack session 历史。

## 历史消息 JSONL
${visibleTranscript}
`
}

export function formatCompactSummary(input: { mode?: 'auto' | 'manual'; summary: string }): string {
  const extracted = stripAnalysisAndExtractSummary(input.summary)
  const cleaned = extracted.trim() || '当前历史中没有需要保留的有效上下文。'
  return `[compact: ${input.mode ?? 'manual'}]\n${cleaned}`
}

/**
 * 从 model 输出中剥掉 <analysis> 块、提取 <summary> 块内容。
 * - <analysis> 是模型思考过程，不进 jsonl
 * - <summary> 是 9 章节正文，jsonl 持久化的就是它
 * - 缺标签时整段返回（兼容老格式 / 模型偶发不带标签）
 *
 * 不再做 noise 过滤（路径名 / 握手关键字）——9 章节 prompt 已不会产出这种
 * 内容，留着会误删合法引用。也不再按字符数截断——max_output_tokens=20K
 * 已是上限。
 */
function stripAnalysisAndExtractSummary(raw: string): string {
  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/)
  const body = summaryMatch ? (summaryMatch[1] ?? '') : withoutAnalysis
  return body.replace(/\n{3,}/g, '\n\n').trim()
}
