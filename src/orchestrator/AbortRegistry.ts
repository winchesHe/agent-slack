/**
 * AbortRegistry：按 key 管理 AbortController 的简单注册表。
 *
 * 设计目标：
 * - create(key) 必须唯一；重复创建视为逻辑错误并抛错
 * - abort(key) 对未知 key 静默 no-op（方便幂等调用）
 * - abortAll() 逐个 abort 并清空，避免泄漏
 */
export class AbortRegistry<Key extends string = string> {
  private readonly controllers = new Map<Key, AbortController>()

  create(key: Key): AbortController {
    if (this.controllers.has(key)) {
      throw new Error(`AbortRegistry.create: key already exists: ${key}`)
    }
    const ctrl = new AbortController()
    this.controllers.set(key, ctrl)
    return ctrl
  }

  abort(key: Key, reason?: unknown): void {
    const ctrl = this.controllers.get(key)
    if (!ctrl) return
    ctrl.abort(reason)
  }

  delete(key: Key): void {
    this.controllers.delete(key)
  }

  abortAll(reason?: unknown): void {
    for (const ctrl of this.controllers.values()) {
      ctrl.abort(reason)
    }
    this.controllers.clear()
  }
}
