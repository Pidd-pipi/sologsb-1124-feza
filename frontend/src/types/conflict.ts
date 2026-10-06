/**
 * 修订基线合并时的待裁定记录。
 * 当两个标签页（邮路页 / 封详情页）基于同一基线把同一实寄封挂到不同邮路，
 * 且两边互不知晓对方改动时，不静默覆盖，落一条待裁定，由人工在邮路页裁决。
 */

/** 冲突类型：当前仅「同一封挂到不同邮路」一类，预留字段级冲突。 */
export type MergeConflictKind = 'coverRoute'

/** 挂接冲突中某一方的主张 */
export interface RouteClaim {
  /** 主张挂到的邮路 id；null 表示主张摘除 */
  routeId: number | null
  /** 邮路当时的节点修订号（便于裁决后补基线） */
  nodesRev: number
  /** 主张来源页面 */
  source: string
  /** 主张时间 */
  at: string
}

export interface MergeConflict {
  id?: number
  kind: MergeConflictKind
  /** 冲突涉及的实寄封 id */
  coverId: number
  /** 封号快照，封被删除后仍可辨认 */
  coverNo: string
  /** 先保存一方的主张（合并时保留） */
  winner: RouteClaim
  /** 后保存一方的主张（挂起待裁定） */
  pending: RouteClaim
  /** 冲突发生时该封的修订基线 */
  baseRev: number
  createdAt: string
  resolvedAt: string
}

/** 生成一条空白主张，供内部调用方补全。 */
export function createClaim(
  routeId: number | null,
  nodesRev: number,
  source: string,
  at: string
): RouteClaim {
  return { routeId, nodesRev, source, at }
}
