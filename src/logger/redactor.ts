export type Redactor = (input: unknown) => string

// JSON.stringify replacer：把嵌套的 Error 实例展开成可见对象。
// Error.message / Error.stack 是非枚举属性，默认 JSON.stringify 会得到 "{}" 黑洞。
function expandErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const enumerable = { ...(value as unknown as Record<string, unknown>) }
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...enumerable,
    }
  }
  return value
}

export function createRedactor(secrets: readonly string[]): Redactor {
  const significant = secrets.filter((s) => typeof s === 'string' && s.length >= 4)
  return (input: unknown): string => {
    let text: string
    if (typeof input === 'string') text = input
    else if (input instanceof Error) text = input.stack ?? input.message
    else {
      try {
        text = JSON.stringify(input, expandErrors)
      } catch {
        text = String(input)
      }
    }
    for (const s of significant) {
      while (text.includes(s)) text = text.replace(s, '[REDACTED]')
    }
    return text
  }
}
