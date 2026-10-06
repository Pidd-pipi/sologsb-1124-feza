/**
 * 写入失败后的可恢复草稿。
 *
 * 与普通表单草稿（utils/draft.ts，编辑过程中自动暂存）不同：
 * 保存动作一旦在事务中失败，会先回滚到保存前的快照，再把「本次试图提交的内容」
 * 连同旧值快照写到 localStorage，用户可在任意编辑页恢复后重试，数据不会丢失。
 */

const PREFIX = 'gbpostmark:draft:recover:'

/** 可回滚草稿的作用域：与三类合并对象对应。 */
export type RecoverScope = 'route' | 'cover' | 'stampentry' | 'route-link'

export interface RecoverDraft {
  /** 记录主键；新建对象失败时可能为空 */
  id: number | null
  scope: RecoverScope
  /** 失败时的提示 */
  reason: string
  /** 试图提交的内容（失败的那份） */
  attempted: unknown
  /** 回滚后保留的保存前快照，便于核对 */
  snapshot: unknown
  failedAt: string
}

function fullKey(scope: RecoverScope, failedAt: string): string {
  return `${PREFIX}${scope}:${failedAt}`
}

/** 保存一份可恢复草稿；返回草稿键名。 */
export function saveRecoverDraft(draft: RecoverDraft): string {
  const key = fullKey(draft.scope, draft.failedAt)
  try {
    window.localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    /* localStorage 不可用（如容量超限）时忽略，事务已回滚不致脏数据 */
  }
  return key
}

/** 读取某个作用域下的全部可恢复草稿，按失败时间倒序。 */
export function listRecoverDrafts(scope?: RecoverScope): RecoverDraft[] {
  const drafts: RecoverDraft[] = []
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key || !key.startsWith(PREFIX)) continue
      if (scope && !key.startsWith(`${PREFIX}${scope}:`)) continue
      try {
        drafts.push(JSON.parse(window.localStorage.getItem(key) ?? '') as RecoverDraft)
      } catch {
        /* 跳过损坏草稿 */
      }
    }
  } catch {
    /* localStorage 不可用时返回空 */
  }
  return drafts.sort((a, b) => (a.failedAt < b.failedAt ? 1 : -1))
}

/** 最近一份可恢复草稿，没有返回 null。 */
export function latestRecoverDraft(scope?: RecoverScope): RecoverDraft | null {
  return listRecoverDrafts(scope)[0] ?? null
}

/** 清除指定作用域（或全部）的可恢复草稿。 */
export function clearRecoverDrafts(scope?: RecoverScope): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key && key.startsWith(PREFIX) && (!scope || key.startsWith(`${PREFIX}${scope}:`))) {
        keys.push(key)
      }
    }
    keys.forEach((key) => window.localStorage.removeItem(key))
  } catch {
    /* ignore */
  }
}

/** 删除单份草稿（按 scope + failedAt）。 */
export function removeRecoverDraft(scope: RecoverScope, failedAt: string): void {
  try {
    window.localStorage.removeItem(fullKey(scope, failedAt))
  } catch {
    /* ignore */
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

/**
 * 执行一次落库动作；底层 IndexedDB 事务在抛错时已自动回滚，
 * 这里在回滚后把「试图提交内容 + 保存前快照」写为可恢复草稿，再把错误继续抛出。
 */
export async function withRecover<T>(
  draft: Omit<RecoverDraft, 'failedAt' | 'reason'> & { reason?: string },
  work: () => Promise<T>
): Promise<T> {
  try {
    return await work()
  } catch (err) {
    saveRecoverDraft({ ...draft, reason: draft.reason ?? errorMessage(err), failedAt: new Date().toISOString() })
    throw err
  }
}
