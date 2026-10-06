/**
 * 修订基线（revision）合并引擎。
 *
 * 邮路、实寄封、票戳组合三类对象共用同一套修订基线：
 * - 互不冲突的挂接直接并入（两页挂到同一条邮路视为同一事实，幂等）。
 * - 同一封被两页挂到不同邮路时，不在后保存覆盖先保存，而是记为「待裁定」。
 * - 邮路节点一改动（nodesRevision 自增），挂在它上面的封的寄递时间轴立即失效，
 *   综合检索命中同步暂停，直到重新确认基线或人工裁定。
 *
 * 本文件只做纯函数计算，不直接读写 IndexedDB，便于在一个事务里调用后落库。
 */
import type { Cover } from '@/types/cover'
import type { PostalRoute } from '@/types/route'
import type { LinkSource, PendingRouteLink } from '@/types/link'
import { BASE_REVISION } from '@/types/route'

/** 取下一个修订号（缺省按初版基线）。 */
export function nextRevision(current: number | null | undefined): number {
  return (typeof current === 'number' && current > 0 ? current : BASE_REVISION - 1) + 1
}

function makeCandidate(
  routeId: number,
  source: LinkSource,
  coverRevision: number,
  routeNodesRevision: number,
  at: string
): PendingRouteLink {
  return { routeId, source, coverRevision, routeNodesRevision, at }
}

/** 对方页面：两个编辑页互相是另一侧。 */
function oppositeSource(source: LinkSource): LinkSource {
  return source === 'route-page' ? 'cover-page' : 'route-page'
}

export interface LinkMergeInput {
  cover: Cover
  /** 目标邮路 id；传 null 表示摘除（显式解除挂接） */
  routeId: number | null
  /** 提出本次挂接的页面 */
  source: LinkSource
  /** 目标邮路当前节点修订号（在事务内查得）；摘除时忽略 */
  targetNodesRevision?: number
  at: string
}

export interface LinkMergeResult {
  routeId: number | null
  linkedNodesRevision: number
  pending: PendingRouteLink[]
  /** 是否与现状不同（需要落库） */
  changed: boolean
  /** 是否产生 / 仍存在待裁定冲突 */
  conflict: boolean
}

/**
 * 按修订基线把一次「挂到某邮路」的编辑并入封：
 * 同邮路幂等并入；不同邮路列为待裁定，绝不静默覆盖。
 */
export function mergeRouteLink(input: LinkMergeInput): LinkMergeResult {
  const { cover, routeId, source, at } = input
  const current = typeof cover.routeId === 'number' ? cover.routeId : null
  const currentPending = cover.pendingRouteLinks ?? []

  // 摘除：显式解除，挂接与候选一并清空（用户当面操作优先于离线分歧）。
  if (routeId == null) {
    const changed = current != null || currentPending.length > 0
    return {
      routeId: null,
      linkedNodesRevision: 0,
      pending: [],
      changed,
      conflict: false
    }
  }

  // 已挂在同一邮路：互不冲突，直接并入（幂等），保留既有基线不动。
  if (current === routeId && !currentPending.some((p) => p.routeId !== routeId)) {
    return {
      routeId: current,
      linkedNodesRevision: cover.linkedNodesRevision ?? 0,
      pending: currentPending,
      changed: false,
      conflict: currentPending.length > 0
    }
  }

  // 候选里已有同一条邮路：重复提议，幂等合并。
  if (currentPending.some((p) => p.routeId === routeId)) {
    return {
      routeId: current,
      linkedNodesRevision: cover.linkedNodesRevision ?? 0,
      pending: currentPending,
      changed: false,
      conflict: true
    }
  }

  // 没有现行挂接：直接并入，并把基线对齐到该邮路当前节点修订号。
  if (current == null) {
    return {
      routeId,
      linkedNodesRevision: input.targetNodesRevision ?? 0,
      pending: [],
      changed: true,
      conflict: false
    }
  }

  // 挂到了不同邮路：保留双方候选，列为待裁定，现行归属冻结不被覆盖。
  const pending: PendingRouteLink[] = [...currentPending]
  if (!pending.some((p) => p.routeId === current)) {
    pending.unshift(
      makeCandidate(
        current,
        oppositeSource(source),
        cover.revision ?? BASE_REVISION,
        cover.linkedNodesRevision ?? 0,
        at
      )
    )
  }
  pending.push(makeCandidate(routeId, source, cover.revision ?? BASE_REVISION, 0, at))
  return {
    routeId: current,
    linkedNodesRevision: cover.linkedNodesRevision ?? 0,
    pending,
    changed: true,
    conflict: true
  }
}

/** 直接并入无现行挂接时，目标邮路节点修订号由调用方（事务内查得）传入。 */

export interface AdjudicateResult {
  routeId: number
  linkedNodesRevision: number
  pending: []
  changed: boolean
}

/** 人工裁定：选定一条候选邮路，清空待裁定并把基线对齐到该邮路当前节点修订号。 */
export function adjudicateRouteLink(
  cover: Cover,
  routeId: number,
  route: PostalRoute | null
): AdjudicateResult {
  const nodesRevision = route?.nodesRevision ?? 0
  const changed = cover.routeId !== routeId || (cover.pendingRouteLinks?.length ?? 0) > 0
  return {
    routeId,
    linkedNodesRevision: nodesRevision,
    pending: [],
    changed
  }
}

/** 驳回分歧：维持现行邮路，清空待裁定，并把基线重新确认到该邮路当前节点修订号。 */
export function keepCurrentRouteLink(
  cover: Cover,
  route: PostalRoute | null
): { routeId: number | null; linkedNodesRevision: number; pending: []; changed: boolean } {
  const current = typeof cover.routeId === 'number' ? cover.routeId : null
  const changed = (cover.pendingRouteLinks?.length ?? 0) > 0
  return {
    routeId: current,
    linkedNodesRevision: current == null ? 0 : route?.nodesRevision ?? 0,
    pending: [],
    changed
  }
}

/** 节点改动后，该封的寄递时间轴是否立即失效（有待裁定或基线落后于邮路节点修订号）。 */
export function isTimelineStale(cover: Cover | null | undefined, route: PostalRoute | null | undefined): boolean {
  if (!cover) return false
  if ((cover.pendingRouteLinks?.length ?? 0) > 0) return true
  if (typeof cover.routeId !== 'number') return false
  if (!route || route.id !== cover.routeId) return true
  return (cover.linkedNodesRevision ?? 0) < (route.nodesRevision ?? 0)
}

/** 综合检索命中是否暂停：失效或待裁定的封先不参与命中。 */
export function isCoverSearchSuspended(
  cover: Cover | null | undefined,
  route: PostalRoute | null | undefined
): boolean {
  return isTimelineStale(cover, route)
}

/** 把历史记录补齐基线字段（升级迁移 / 启动自检共用），返回是否有改动。 */
export function ensureCoverBaseline(
  cover: Partial<Cover>,
  routeOf: (id: number) => PostalRoute | null | undefined
): boolean {
  let changed = false
  if (typeof cover.revision !== 'number' || cover.revision < 1) {
    cover.revision = BASE_REVISION
    changed = true
  }
  if (typeof cover.linkedNodesRevision !== 'number') {
    const rt = typeof cover.routeId === 'number' ? routeOf(cover.routeId) : null
    cover.linkedNodesRevision = rt?.nodesRevision ?? 0
    changed = true
  }
  if (!Array.isArray(cover.pendingRouteLinks)) {
    cover.pendingRouteLinks = []
    changed = true
  }
  return changed
}

export function ensureRouteBaseline(route: Partial<PostalRoute>): boolean {
  let changed = false
  if (typeof route.revision !== 'number' || route.revision < 1) {
    route.revision = BASE_REVISION
    changed = true
  }
  if (typeof route.nodesRevision !== 'number') {
    route.nodesRevision = 0
    changed = true
  }
  if (typeof route.nodesChangedAt !== 'string' || !route.nodesChangedAt) {
    route.nodesChangedAt = ''
    changed = true
  }
  return changed
}
