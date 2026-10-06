/**
 * 挂接（Link）：实寄封与邮路之间「挂到哪条邮路」的归属关系。
 *
 * 设计要点：
 * - 邮路页、实寄封页可能同时（或先后离线）编辑同一封的归属；两边按修订基线合并。
 * - 两边挂到同一条邮路 → 互不冲突，直接并入（只保留一条）。
 * - 同一封被两页挂到不同邮路 → 记为待裁定（pending），由人工选定，不再静默覆盖。
 */

/** 挂接来源：哪个编辑页提出的挂接，用于冲突留痕。 */
export type LinkSource = 'route-page' | 'cover-page'

/** 待裁定的邮路挂接：同一封被挂到两条不同邮路时各保留一条候选。 */
export interface PendingRouteLink {
  /** 候选邮路 id */
  routeId: number
  /** 提出该挂接的页面 */
  source: LinkSource
  /** 挂接时封上记录的基线 */
  coverRevision: number
  /** 挂接时邮路的节点修订号 */
  routeNodesRevision: number
  /** 记录时间（ISO） */
  at: string
}
