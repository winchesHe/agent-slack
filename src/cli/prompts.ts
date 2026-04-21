// @clack/prompts 的薄包装：单一 Prompter 接口便于 onboard 测试时注入 mock
import * as clack from '@clack/prompts'

export interface SelectOption<T> {
  label: string
  value: T
  hint?: string
}

export interface Prompter {
  text(opts: {
    message: string
    initialValue?: string
    validate?: (value: string) => string | undefined
  }): Promise<string>
  password(opts: {
    message: string
    validate?: (value: string) => string | undefined
  }): Promise<string>
  select<T>(opts: {
    message: string
    options: Array<SelectOption<T>>
    initialValue?: T
  }): Promise<T>
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>
  intro(msg: string): void
  outro(msg: string): void
  note(msg: string, title?: string): void
}

export class PrompterCancelled extends Error {
  constructor() {
    super('prompter cancelled')
    this.name = 'PrompterCancelled'
  }
}

export function createClackPrompter(): Prompter {
  const guard = <T>(value: T | symbol): T => {
    if (clack.isCancel(value)) throw new PrompterCancelled()
    return value as T
  }
  return {
    async text(opts) {
      const { validate, ...rest } = opts
      return guard<string>(
        await clack.text({
          ...rest,
          ...(validate ? { validate: (v: string | undefined) => validate(v ?? '') } : {}),
        }),
      )
    },
    async password(opts) {
      const { validate, ...rest } = opts
      return guard<string>(
        await clack.password({
          ...rest,
          ...(validate ? { validate: (v: string | undefined) => validate(v ?? '') } : {}),
        }),
      )
    },
    async select<T>(opts: {
      message: string
      options: Array<SelectOption<T>>
      initialValue?: T
    }): Promise<T> {
      return guard<T>(await clack.select(opts as never))
    },
    async confirm(opts) {
      const v = guard<boolean>(await clack.confirm(opts))
      return Boolean(v)
    },
    intro: (m) => clack.intro(m),
    outro: (m) => clack.outro(m),
    note: (m, t) => clack.note(m, t),
  }
}
