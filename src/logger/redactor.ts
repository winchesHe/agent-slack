export type Redactor = (input: unknown) => string

export function createRedactor(secrets: readonly string[]): Redactor {
  const significant = secrets.filter((s) => typeof s === 'string' && s.length >= 4)
  return (input: unknown): string => {
    let text: string
    if (typeof input === 'string') text = input
    else if (input instanceof Error) text = input.stack ?? input.message
    else {
      try {
        text = JSON.stringify(input)
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
