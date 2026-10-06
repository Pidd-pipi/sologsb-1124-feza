/** 表单草稿：写在浏览器 localStorage，刷新或误关页面后可恢复。 */

const PREFIX = 'gbpostmark:draft:'

export type DraftKey = 'postmark' | 'cover' | 'route' | 'stampentry'

function fullKey(key: string): string {
  return `${PREFIX}${key}`
}

/** 保存草稿；序列化失败时静默忽略，不影响主流程。 */
export function saveDraft<T>(key: DraftKey | string, value: T): void {
  try {
    window.localStorage.setItem(
      fullKey(key),
      JSON.stringify({ savedAt: new Date().toISOString(), value })
    )
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 读取草稿，返回 null 表示没有可用草稿。 */
export function loadDraft<T>(key: DraftKey | string): T | null {
  try {
    const raw = window.localStorage.getItem(fullKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { value?: T }
    return (parsed && 'value' in parsed ? (parsed.value as T) : null) ?? null
  } catch {
    return null
  }
}

/** 草稿保存时间。 */
export function draftSavedAt(key: DraftKey | string): string {
  try {
    const raw = window.localStorage.getItem(fullKey(key))
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { savedAt?: string }
    return parsed?.savedAt ?? ''
  } catch {
    return ''
  }
}

/** 清除草稿。 */
export function clearDraft(key: DraftKey | string): void {
  try {
    window.localStorage.removeItem(fullKey(key))
  } catch {
    /* ignore */
  }
}

/** 列出全部草稿键，页面测试与调试使用。 */
export function listDraftKeys(): string[] {
  const keys: string[] = []
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(PREFIX)) keys.push(k)
    }
  } catch {
    /* ignore */
  }
  return keys
}

/* --------------------- 写失败后的可恢复草稿（recover） --------------------- */

/**
 * 写库失败后留下的可恢复草稿：除表单内容外，记录失败原因、修订基线与目标 id，
 * 重新进入页面时可一键恢复到失败前的编辑现场再重试。
 */
export interface RecoverableDraft<T = unknown> {
  savedAt: string
  /** 写库失败的错误信息 */
  reason: string
  /** 目标记录 id；新建失败时为 null */
  targetId: number | null
  /** 失败时携带的修订基线，重试时用于三向合并 */
  baseRev: number | null
  value: T
}

const RECOVER_PREFIX = 'gbpostmark:recover:'

function recoverKey(scope: string): string {
  return `${RECOVER_PREFIX}${scope}`
}

/** 写失败时调用：把失败的写入内容存成可恢复草稿。 */
export function saveRecoverableDraft<T>(
  scope: DraftKey | string,
  payload: Omit<RecoverableDraft<T>, 'savedAt'>
): void {
  try {
    const record: RecoverableDraft<T> = { savedAt: new Date().toISOString(), ...payload }
    window.localStorage.setItem(recoverKey(scope), JSON.stringify(record))
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 读取可恢复草稿；没有返回 null。 */
export function loadRecoverableDraft<T>(scope: DraftKey | string): RecoverableDraft<T> | null {
  try {
    const raw = window.localStorage.getItem(recoverKey(scope))
    if (!raw) return null
    const parsed = JSON.parse(raw) as RecoverableDraft<T>
    return parsed && 'value' in parsed ? parsed : null
  } catch {
    return null
  }
}

/** 写入成功（或用户放弃恢复）后清除可恢复草稿。 */
export function clearRecoverableDraft(scope: DraftKey | string): void {
  try {
    window.localStorage.removeItem(recoverKey(scope))
  } catch {
    /* ignore */
  }
}
