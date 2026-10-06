import {
  mergeRouteLink,
  adjudicateRouteLink,
  keepCurrentRouteLink,
  isTimelineStale,
  nextRevision,
  ensureCoverBaseline,
  ensureRouteBaseline
} from '../src/utils/revision'
import { createEmptyCover } from '../src/types/cover'
import type { PostalRoute } from '../src/types/route'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1
    console.error('FAIL:', msg)
  } else {
    console.log('ok  :', msg)
  }
}

const now = '2026-10-06T00:00:00.000Z'
const route1 = { id: 1, nodesRevision: 3 } as PostalRoute
const route2 = { id: 2, nodesRevision: 1 } as PostalRoute

// 1) 无挂接时直接并入，基线对齐到目标邮路
let cover = createEmptyCover()
let r = mergeRouteLink({ cover, routeId: 1, source: 'route-page', targetNodesRevision: 3, at: now })
assert(r.changed && r.routeId === 1 && r.linkedNodesRevision === 3 && !r.conflict, '无挂接 → 并入并对齐基线')
cover = { ...cover, routeId: 1, linkedNodesRevision: 3, pendingRouteLinks: r.pending }

// 2) 两页挂到同一邮路 → 幂等，不产生待裁定
r = mergeRouteLink({ cover, routeId: 1, source: 'cover-page', targetNodesRevision: 3, at: now })
assert(!r.changed && !r.conflict && r.pending.length === 0, '同邮路重复挂接 → 幂等并入')

// 3) 另一页挂到不同邮路 → 待裁定，现行不被覆盖
r = mergeRouteLink({ cover, routeId: 2, source: 'cover-page', targetNodesRevision: 1, at: now })
assert(r.changed && r.conflict, '不同邮路 → 产生冲突')
assert(r.routeId === 1, '冲突时现行挂接冻结，不被后保存覆盖')
assert(r.pending.length === 2, '保留两条候选待裁定')
assert(r.pending.some((p) => p.routeId === 1) && r.pending.some((p) => p.routeId === 2), '候选含两条邮路')
cover = { ...cover, routeId: r.routeId, linkedNodesRevision: r.linkedNodesRevision, pendingRouteLinks: r.pending }

// 4) 待裁定期间时间轴失效、检索暂停
assert(isTimelineStale(cover, route1), '待裁定 → 时间轴失效')

// 5) 裁定到邮路 2 → 清空候选，基线对齐
let a = adjudicateRouteLink(cover, 2, route2)
assert(a.changed && a.routeId === 2 && a.linkedNodesRevision === 1 && a.pending.length === 0, '裁定 → 选定邮路并对齐基线')
cover = { ...cover, routeId: a.routeId, linkedNodesRevision: a.linkedNodesRevision, pendingRouteLinks: [] }
assert(!isTimelineStale(cover, route2), '裁定后时间轴恢复有效')

// 6) 节点改动推进 nodesRevision → 立即失效
assert(isTimelineStale(cover, { ...route2, nodesRevision: 2 }), '节点改动 → 时间轴立即失效')

// 7) 维持现行
const pendingCover = { ...createEmptyCover(), id: 5, routeId: 1, linkedNodesRevision: 0, pendingRouteLinks: [{ routeId: 1, source: 'route-page', coverRevision: 1, routeNodesRevision: 0, at: now }, { routeId: 2, source: 'cover-page', coverRevision: 1, routeNodesRevision: 0, at: now }] }
const k = keepCurrentRouteLink(pendingCover, route1)
assert(k.changed && k.routeId === 1 && k.pending.length === 0 && k.linkedNodesRevision === 3, '维持现行 → 清空候选对齐基线')

// 8) 摘除 → 清空候选与失效
r = mergeRouteLink({ cover: pendingCover, routeId: null, source: 'route-page', at: now })
assert(r.routeId === null && r.pending.length === 0 && !r.conflict && r.linkedNodesRevision === 0, '摘除 → 清空挂接与候选')

// 9) nextRevision
assert(nextRevision(undefined) === 1 && nextRevision(3) === 4, '修订号自增')

// 10) 旧数据补基线：已挂带节点邮路的封不失效
const oldRoute = { id: 9, nodes: [{ key: 'a', office: 'X', arriveDate: '1910-01-01', transitMark: '' }] } as unknown as Partial<PostalRoute>
ensureRouteBaseline(oldRoute)
if ((oldRoute.nodesRevision ?? 0) === 0) oldRoute.nodesRevision = 1
const oldCover = { routeId: 9 } as Partial<ReturnType<typeof createEmptyCover>>
const changed = ensureCoverBaseline(oldCover as never, (id) => (id === 9 ? (oldRoute as PostalRoute) : null))
assert(changed && oldCover.linkedNodesRevision === 1 && oldCover.revision === 1, '旧数据补基线并与既有节点对齐')

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部合并引擎断言通过')
