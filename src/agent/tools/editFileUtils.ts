// edit_file 文本匹配辅助：借鉴 free-code 的思路，把“匹配/替换规则”与工具 I/O 分离。

export const LEFT_SINGLE_CURLY_QUOTE = '‘'
export const RIGHT_SINGLE_CURLY_QUOTE = '’'
export const LEFT_DOUBLE_CURLY_QUOTE = '“'
export const RIGHT_DOUBLE_CURLY_QUOTE = '”'

// 将弯引号统一归一化成直引号，便于做“内容等价但字符不同”的匹配。
export function normalizeQuotes(input: string): string {
  return input
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

// 先尝试精确匹配；失败时再用引号归一化后的内容定位真实片段。
export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) {
    return searchString
  }

  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const index = normalizedFile.indexOf(normalizedSearch)
  if (index === -1) {
    return null
  }
  return fileContent.slice(index, index + searchString.length)
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true
  }
  const previous = chars[index - 1]
  return (
    previous === ' ' ||
    previous === '\t' ||
    previous === '\n' ||
    previous === '\r' ||
    previous === '(' ||
    previous === '[' ||
    previous === '{' ||
    previous === '—' ||
    previous === '–'
  )
}

function applyCurlyDoubleQuotes(input: string): string {
  const chars = [...input]
  const output: string[] = []
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] === '"') {
      output.push(
        isOpeningContext(chars, index) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE,
      )
      continue
    }
    output.push(chars[index]!)
  }
  return output.join('')
}

function applyCurlySingleQuotes(input: string): string {
  const chars = [...input]
  const output: string[] = []
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] === "'") {
      const previous = index > 0 ? chars[index - 1] : undefined
      const next = index < chars.length - 1 ? chars[index + 1] : undefined
      const prevIsLetter = previous !== undefined && /\p{L}/u.test(previous)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      if (prevIsLetter && nextIsLetter) {
        output.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        output.push(
          isOpeningContext(chars, index) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE,
        )
      }
      continue
    }
    output.push(chars[index]!)
  }
  return output.join('')
}

// 当 old_string 通过引号归一化匹配到文件内容时，尽量沿用文件现有引号风格。
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString
  }

  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)

  let result = newString
  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result)
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result)
  }
  return result
}

export function countOccurrences(fileContent: string, target: string): number {
  return fileContent.split(target).length - 1
}

export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  return replaceAll
    ? originalContent.split(oldString).join(newString)
    : originalContent.replace(oldString, newString)
}
