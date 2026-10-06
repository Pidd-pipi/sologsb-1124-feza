/**
 * 修订通知总线：任一标签页改了邮路节点 / 封挂接 / 票戳组合后广播，
 * 其它标签页立即收到并刷新，使详情页时间轴、综合检索立刻感知失效。
 *
 * 同源标签页之间通过 localStorage 的 storage 事件通信；
 * 本标签页内的改动直接走订阅者回调（storage 事件不回投发起页）。
 */

const CHANNEL_KEY = 'gbpostmark:revision-bus'

/** 修订实体类型 */
export type RevisionKind = 'route' | 'cover' | 'stampEntry' | 'postmark' | 'conflict'

export interface RevisionMessage {
  /** 被改动记录的 id（冲突类为 0） */
  id: number
  kind: RevisionKind
  /** 是否节点结构改动（仅 route 使用）：为 true 时挂接封时间轴立即失效 */
  nodesChanged?: boolean
  at: string
}

type Listener = (msg: RevisionMessage) => void
const listeners = new Set<Listener>()

function emitLocal(msg: RevisionMessage): void {
  for (const fn of listeners) {
    try {
      fn(msg)
    } catch {
      /* 单个订阅者异常不影响其它订阅者 */
    }
  }
}

/** 发布一次修订：通知其它标签页，并同步通知本标签页订阅者。 */
export function publishRevision(msg: Omit<RevisionMessage, 'at'>): void {
  const full: RevisionMessage = { ...msg, at: new Date().toISOString() }
  emitLocal(full)
  try {
    window.localStorage.setItem(CHANNEL_KEY, JSON.stringify(full))
  } catch {
    /* localStorage 不可用时本标签页内仍可生效 */
  }
}

/** 订阅修订消息；返回取消订阅函数。 */
export function onRevision(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== CHANNEL_KEY || !event.newValue) return
    try {
      emitLocal(JSON.parse(event.newValue) as RevisionMessage)
    } catch {
      /* 无法解析的消息忽略 */
    }
  })
}
