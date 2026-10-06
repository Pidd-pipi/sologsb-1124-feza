// store 端到端：基线合并、节点改动失效、跨页冲突待裁定、失败回滚与恢复草稿。
import 'fake-indexeddb/auto'
import { setActivePinia, createPinia } from 'pinia'

// 内存 localStorage，供失败恢复草稿验证
const mem = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() {
    return mem.size
  }
}
;(globalThis as Record<string, unknown>).window = { localStorage: localStorageShim }
;(globalThis as Record<string, unknown>).localStorage = localStorageShim

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1
    console.error('FAIL:', msg)
  } else console.log('ok  :', msg)
}

setActivePinia(createPinia())
const { useRouteStore } = await import('../src/stores/routeStore')
const { useCoverStore } = await import('../src/stores/coverStore')
const { createEmptyRoute } = await import('../src/types/route')
const { createEmptyCover } = await import('../src/types/cover')

const routeStore = useRouteStore()
const coverStore = useCoverStore()

// 建两条邮路（各带节点）
const rtA = { ...createEmptyRoute(), routeNo: 'RT-0001', name: '甲邮路', nodes: [
  { key: 'n1', office: '上海', arriveDate: '1910-06-18', transitMark: '收寄' },
  { key: 'n2', office: '南京', arriveDate: '1910-06-21', transitMark: '到达' }
] }
const idA = await routeStore.create(rtA)
const rtB = { ...createEmptyRoute(), routeNo: 'RT-0002', name: '乙邮路', nodes: [
  { key: 'm1', office: '天津', arriveDate: '1921-03-05', transitMark: '收寄' }
] }
const idB = await routeStore.create(rtB)
assert(routeStore.byId(idA)?.nodesRevision === 1, '新建带节点邮路 nodesRevision=1')

// 建一封并挂到甲邮路（模拟邮路页挂接）
const cover = { ...createEmptyCover(), coverNo: 'CV-1001', sentFrom: '上海', sentTo: '南京', postDate: '1910-06-18', arriveDate: '1910-06-21' }
const coverId = await coverStore.create({ ...cover, routeId: null })
let res = await coverStore.attachRoute(coverId, idA, 'route-page')
assert(res.changed && !res.conflict && res.routeId === idA, '首次挂接直接并入')
assert(!coverStore.isStale(coverStore.byId(coverId)), '刚挂接时间轴有效')

// 节点改动（新增中转节点）→ 时间轴立即失效，检索暂停
await routeStore.addNode(idA, { key: 'new', office: '镇江', arriveDate: '1910-06-20', transitMark: '中转' }, 1)
assert(routeStore.byId(idA)?.nodesRevision === 2, '节点改动推进 nodesRevision=2')
assert(coverStore.isStale(coverStore.byId(coverId)), '节点改动后时间轴立即失效')
assert(coverStore.isSearchSuspended(coverStore.byId(coverId)), '失效封检索命中暂停')
assert(coverStore.staleCoversForRoute(idA).length === 1, '邮路页统计到 1 个失效封')

// 重新确认 → 恢复
await coverStore.confirmTimeline(coverId)
assert(!coverStore.isStale(coverStore.byId(coverId)), '确认基线后时间轴恢复')

// 另一页把同一封挂到乙邮路 → 待裁定，原挂接不被覆盖
res = await coverStore.attachRoute(coverId, idB, 'cover-page')
assert(res.conflict && res.routeId === idA, '跨页挂不同邮路 → 待裁定，现行仍为甲')
assert(res.pending.length === 2, '待裁定两条候选')
assert(coverStore.isStale(coverStore.byId(coverId)), '待裁定期间时间轴失效')
assert(coverStore.pendingCoversForRoute(idB).length === 1, '乙邮路页能看到这条待裁定')
assert(coverStore.pendingCoversForRoute(idA).length === 1, '甲邮路页也能看到这条待裁定')

// 同邮路重复挂接不改变
res = await coverStore.attachRoute(coverId, idB, 'route-page')
assert(res.conflict && res.pending.length === 2, '重复候选幂等')

// 裁定给乙 → 恢复
await coverStore.adjudicateRoute(coverId, idB)
const afterJudge = coverStore.byId(coverId)!
assert(afterJudge.routeId === idB && afterJudge.pendingRouteLinks.length === 0, '裁定后归属乙、候选清空')
assert(!coverStore.isStale(afterJudge), '裁定后时间轴恢复有效')

// 摘除
await coverStore.attachRoute(coverId, null, 'cover-page')
assert(coverStore.byId(coverId)!.routeId === null, '摘除后无邮路')
assert(!coverStore.isStale(coverStore.byId(coverId)), '未挂邮路不判失效')

// 失败回滚 + 恢复草稿：更新不存在的封，应抛错且留下草稿
let threw = false
try {
  await coverStore.update(999999, { note: 'x' })
} catch {
  threw = true
}
assert(threw, '保存不存在的封抛错（事务回滚）')
const keys = Array.from(mem.keys()).filter((k) => k.includes('recover'))
assert(keys.some((k) => k.includes('cover')), '失败后写入了可恢复草稿')

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\nstore 端到端断言全部通过')
