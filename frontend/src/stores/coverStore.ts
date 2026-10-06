import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, saveAsset } from '@/utils/db'
import type { Cover, FrankingItem } from '@/types/cover'
import type { PostalRoute } from '@/types/route'
import type { StamplessEntry } from '@/types/stampentry'
import type { LinkSource } from '@/types/link'
import { nextSerialNo, nowIso } from '@/utils/id'
import {
  adjudicateRouteLink,
  isTimelineStale,
  keepCurrentRouteLink,
  mergeRouteLink,
  nextRevision,
  type LinkMergeResult
} from '@/utils/revision'
import { withRecover } from '@/utils/recover'
import type { ImagePayload } from './postmarkStore'
import { useRouteStore } from './routeStore'

export const useCoverStore = defineStore('cover', () => {
  const list = ref<Cover[]>([])
  const entries = ref<StamplessEntry[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.covers.orderBy('coverNo').toArray()
      entries.value = await db.stampEntries.toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 生成下一个封号，如 CV-0005 */
  function nextCoverNo(): string {
    return nextSerialNo('CV-', list.value.map((c) => c.coverNo))
  }

  async function create(
    input: Cover,
    images?: Partial<Record<'front' | 'back', ImagePayload>>
  ): Promise<number> {
    const now = nowIso()
    const targetRoute =
      typeof input.routeId === 'number' ? await db.routes.get(input.routeId) : null
    const record: Cover = {
      ...input,
      coverNo: input.coverNo || nextCoverNo(),
      franking: input.franking.map((f) => ({ ...f })),
      cancelPmIds: [...input.cancelPmIds],
      viaPoints: [...input.viaPoints],
      revision: nextRevision(input.revision),
      linkedNodesRevision: targetRoute?.nodesRevision ?? 0,
      pendingRouteLinks: [],
      createdAt: now,
      updatedAt: now
    }
    delete record.id
    let newId = 0
    await withRecover(
      { id: null, scope: 'cover', attempted: { record, images: images ?? null }, snapshot: null },
      async () => {
        // 封与封图同一事务：任一失败整体回滚，不留半截数据
        await db.transaction('rw', db.covers, db.assets, async () => {
          newId = await db.covers.add(record)
          for (const side of ['front', 'back'] as const) {
            const payload = images?.[side]
            if (payload && payload.dataUrl) {
              await saveAsset({
                ownerType: 'cover',
                ownerId: newId,
                side,
                dataUrl: payload.dataUrl,
                fileName: payload.fileName,
                updatedAt: now
              })
            }
          }
        })
      }
    )
    await load()
    return newId
  }

  /** 通用字段保存：每次保存自增基线，失败回滚并留可恢复草稿。 */
  async function update(id: number, patch: Partial<Cover>): Promise<void> {
    const before = await db.covers.get(id)
    const now = nowIso()
    await withRecover(
      {
        id,
        scope: 'cover',
        attempted: { ...(before ?? {}), ...patch, id },
        snapshot: before ?? null
      },
      async () => {
        if (!before) throw new Error(`实寄封 ${id} 不存在，保存已回滚`)
        const next: Partial<Cover> = {
          ...patch,
          updatedAt: now,
          revision: nextRevision(before.revision)
        }
        await db.covers.update(id, next)
      }
    )
    await load()
  }

  async function remove(id: number): Promise<void> {
    const before = await db.covers.get(id)
    const own = await db.stampEntries.where('coverId').equals(id).toArray()
    await withRecover(
      { id, scope: 'cover', attempted: { deleted: true }, snapshot: { cover: before, entries: own } },
      async () => {
        await db.transaction('rw', db.covers, db.stampEntries, async () => {
          await db.covers.delete(id)
          await db.stampEntries.bulkDelete(
            own.map((e) => e.id).filter((v): v is number => typeof v === 'number')
          )
        })
      }
    )
    await load()
  }

  /**
   * 把封挂到某邮路（或摘除）。按修订基线合并：
   * 同邮路幂等并入；不同邮路不覆盖，列待裁定。返回合并结果供页面提示。
   */
  async function attachRoute(
    coverId: number,
    routeId: number | null,
    source: LinkSource
  ): Promise<LinkMergeResult> {
    const before = await db.covers.get(coverId)
    let merged: LinkMergeResult | null = null
    await withRecover(
      {
        id: coverId,
        scope: 'route-link',
        attempted: { routeId, source },
        snapshot: before ?? null
      },
      async () => {
        if (!before) throw new Error(`实寄封 ${coverId} 不存在，挂接已回滚`)
        await db.transaction('rw', db.covers, db.routes, async () => {
          const cover = await db.covers.get(coverId)
          if (!cover) throw new Error('实寄封在保存时已被删除')
          const target = routeId == null ? null : await db.routes.get(routeId)
          if (routeId != null && !target) throw new Error(`邮路 ${routeId} 不存在，挂接已回滚`)
          const result = mergeRouteLink({
            cover,
            routeId,
            source,
            targetNodesRevision: target?.nodesRevision ?? 0,
            at: nowIso()
          })
          merged = result
          if (result.changed) {
            await db.covers.update(coverId, {
              routeId: result.routeId,
              linkedNodesRevision: result.linkedNodesRevision,
              pendingRouteLinks: result.pending,
              revision: nextRevision(cover.revision),
              updatedAt: nowIso()
            })
          }
        })
      }
    )
    await load()
    return (
      merged ??
      (before
        ? {
            routeId: before.routeId,
            linkedNodesRevision: before.linkedNodesRevision ?? 0,
            pending: before.pendingRouteLinks ?? [],
            changed: false,
            conflict: (before.pendingRouteLinks?.length ?? 0) > 0
          }
        : {
            routeId: null,
            linkedNodesRevision: 0,
            pending: [],
            changed: false,
            conflict: false
          })
    )
  }

  /** 人工裁定：选定一条候选邮路。 */
  async function adjudicateRoute(coverId: number, routeId: number): Promise<boolean> {
    const before = await db.covers.get(coverId)
    let changed = false
    await withRecover(
      { id: coverId, scope: 'route-link', attempted: { adjudicate: routeId }, snapshot: before ?? null },
      async () => {
        if (!before) throw new Error(`实寄封 ${coverId} 不存在，裁定已回滚`)
        await db.transaction('rw', db.covers, db.routes, async () => {
          const cover = await db.covers.get(coverId)
          if (!cover) throw new Error('实寄封在裁定时已被删除')
          const route = await db.routes.get(routeId)
          if (!route) throw new Error(`邮路 ${routeId} 不存在，裁定已回滚`)
          const result = adjudicateRouteLink(cover, routeId, route)
          changed = result.changed
          if (changed) {
            await db.covers.update(coverId, {
              routeId: result.routeId,
              linkedNodesRevision: result.linkedNodesRevision,
              pendingRouteLinks: [],
              revision: nextRevision(cover.revision),
              updatedAt: nowIso()
            })
          }
        })
      }
    )
    await load()
    return changed
  }

  /** 驳回分歧：维持现行邮路，仅清空待裁定并重新确认基线。 */
  async function keepCurrentRoute(coverId: number): Promise<void> {
    const before = await db.covers.get(coverId)
    if (!before) return
    await withRecover(
      { id: coverId, scope: 'route-link', attempted: { keepCurrent: true }, snapshot: before },
      async () => {
        await db.transaction('rw', db.covers, db.routes, async () => {
          const cover = await db.covers.get(coverId)
          if (!cover) return
          const route =
            typeof cover.routeId === 'number' ? await db.routes.get(cover.routeId) : null
          const result = keepCurrentRouteLink(cover, route ?? null)
          if (result.changed) {
            await db.covers.update(coverId, {
              routeId: result.routeId,
              linkedNodesRevision: result.linkedNodesRevision,
              pendingRouteLinks: [],
              revision: nextRevision(cover.revision),
              updatedAt: nowIso()
            })
          }
        })
      }
    )
    await load()
  }

  /** 节点改动后重新确认时间轴：把挂接基线对齐到邮路当前节点修订号。 */
  async function confirmTimeline(coverId: number): Promise<void> {
    const before = await db.covers.get(coverId)
    if (!before || (before.pendingRouteLinks?.length ?? 0) > 0) return
    if (typeof before.routeId !== 'number') return
    await withRecover(
      { id: coverId, scope: 'route-link', attempted: { confirm: true }, snapshot: before },
      async () => {
        await db.transaction('rw', db.covers, db.routes, async () => {
          const cover = await db.covers.get(coverId)
          const route = cover ? await db.routes.get(cover.routeId as number) : null
          if (!cover || !route) return
          if ((cover.linkedNodesRevision ?? 0) >= (route.nodesRevision ?? 0)) return
          await db.covers.update(coverId, {
            linkedNodesRevision: route.nodesRevision,
            updatedAt: nowIso()
          })
        })
      }
    )
    await load()
  }

  async function addEntry(input: StamplessEntry): Promise<number> {
    const record: StamplessEntry = { ...input, revision: nextRevision(input.revision), createdAt: nowIso() }
    let newId = 0
    await withRecover(
      { id: null, scope: 'stampentry', attempted: record, snapshot: null },
      async () => {
        newId = await db.stampEntries.add(record)
      }
    )
    await load()
    return newId
  }

  async function removeEntry(id: number): Promise<void> {
    const before = await db.stampEntries.get(id)
    await withRecover(
      { id, scope: 'stampentry', attempted: { deleted: true }, snapshot: before ?? null },
      async () => {
        await db.stampEntries.delete(id)
      }
    )
    await load()
  }

  function byId(id: number | null | undefined): Cover | null {
    if (id == null) return null
    return list.value.find((c) => c.id === id) ?? null
  }

  /** 某个封下的票戳组合明细 */
  function entriesOf(coverId: number | null | undefined): StamplessEntry[] {
    if (coverId == null) return []
    return entries.value.filter((e) => e.coverId === coverId)
  }

  /** 贴票枚数（行内展示用） */
  function frankingCount(cover: Cover | null): number {
    if (!cover) return 0
    return cover.franking.reduce((sum, f: FrankingItem) => sum + (Number(f.count) || 0), 0)
  }

  /** 关联邮戳数（行内展示用） */
  function cancelCount(cover: Cover | null): number {
    return cover ? cover.cancelPmIds.length : 0
  }

  function routeOf(cover: Cover): PostalRoute | null {
    return useRouteStore().byId(cover.routeId)
  }

  /** 封的寄递时间轴是否失效（待裁定或邮路节点改动后基线落后）。 */
  function isStale(cover: Cover | null | undefined): boolean {
    return isTimelineStale(cover ?? null, cover ? routeOf(cover) : null)
  }

  /** 综合检索是否暂停命中该封。 */
  function isSearchSuspended(cover: Cover | null | undefined): boolean {
    return isStale(cover)
  }

  /** 有待裁定挂接的封。 */
  const pendingCovers = computed<Cover[]>(() =>
    list.value.filter((c) => (c.pendingRouteLinks?.length ?? 0) > 0)
  )

  /** 时间轴失效（含待裁定）的封 id 集合，供检索暂停等场景快速判断。 */
  const staleCoverIds = computed<Set<number>>(() => {
    const ids = new Set<number>()
    for (const cover of list.value) {
      if (isStale(cover) && typeof cover.id === 'number') ids.add(cover.id)
    }
    return ids
  })

  /** 与某条邮路相关的待裁定封（现行挂在该邮路，或候选里含该邮路）。 */
  function pendingCoversForRoute(routeId: number): Cover[] {
    return list.value.filter((c) => {
      if (!(c.pendingRouteLinks?.length > 0)) return false
      return c.routeId === routeId || c.pendingRouteLinks.some((p) => p.routeId === routeId)
    })
  }

  /** 因该邮路节点改动而时间轴失效的封。 */
  function staleCoversForRoute(routeId: number): Cover[] {
    return list.value.filter(
      (c) => typeof c.id === 'number' && c.routeId === routeId && isStale(c)
    )
  }

  const coversOfRoute = computed(() => {
    return (routeId: number): Cover[] => list.value.filter((c) => c.routeId === routeId)
  })

  const total = computed(() => list.value.length)
  const registeredCount = computed(() => list.value.filter((c) => c.registered).length)

  return {
    list,
    entries,
    loading,
    loaded,
    total,
    registeredCount,
    coversOfRoute,
    pendingCovers,
    staleCoverIds,
    load,
    nextCoverNo,
    create,
    update,
    remove,
    attachRoute,
    adjudicateRoute,
    keepCurrentRoute,
    confirmTimeline,
    addEntry,
    removeEntry,
    byId,
    entriesOf,
    frankingCount,
    cancelCount,
    isStale,
    isSearchSuspended,
    pendingCoversForRoute,
    staleCoversForRoute
  }
})
