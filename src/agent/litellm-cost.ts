function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 从 providerMetadata 里提取 LiteLLM/OpenAI 兼容层回传的美元成本。
 * 读取不到时返回 undefined，让上层统一回落到 0。
 */
export function extractCostFromMetadata(metadata: unknown): number | undefined {
  const root = asRecord(metadata)
  if (!root) {
    return undefined
  }

  const litellm = asRecord(root.litellm)
  const openaiCompat = asRecord(root.openaiCompat)

  return (
    asFiniteNumber(litellm?.cost) ??
    asFiniteNumber(litellm?.response_cost) ??
    asFiniteNumber(openaiCompat?.cost)
  )
}
