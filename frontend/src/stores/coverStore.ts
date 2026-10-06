import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, saveAsset } from '@/utils/db'
import type { Cover, FrankingItem } from '@/types/cover'
import type { StamplessEntry } from '@/types/stampentry'
import { INITIAL_REV } from '@/types/route'
import type { MergeConflict, RouteClaim } from '@/types/conflict'
import { nextSerialNo, nowIso } from '@/utils/id'
import type { ImagePayload } from './postmarkStore'
import { threeWayMerge, type MergePatch } from '@/utils/revision'
import { publishRevision } from '@/utils/revisionBus'

export interface CoverSaveOutcome {
  conflictFields: string[]
  /** 本次保存是否产生了待裁定挂接 */
  routeConflict: MergeConflict | null
}

/** 挂接来源标记，写入待裁定记录，方便回溯是哪个页面先保存。 */
export const ATTACH_SOURCE = 'route-page'
export const DETACH_SOURCE = 'route-page:detach'

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
    const record: Cover = {
      ...input,
      coverNo: input.coverNo || nextCoverNo(),
      franking: input.franking.map((f) => ({ ...f })),
      cancelPmIds: [...input.cancelPmIds],
      viaPoints: [...input.viaPoints],
      routeId: typeof input.routeId === 'number' ? input.routeId : null,
      rev: INITIAL_REV,
      // 新建即挂接：按所挂邮路当前 nodesRev 补基线；未挂则无节点可失效
      timelineBaseRev: INITIAL_REV,
      createdAt: now,
      updatedAt: now
    }
    delete record.id
    const id = await db.transaction('rw', db.covers, db.assets, db.routes, async () => {
      const newId = await db.covers.add(record)
      if (typeof record.routeId === 'number') {
        const route = await db.routes.get(record.routeId)
        if (route) {
          await db.covers.update(newId, { timelineBaseRev: route.nodesRev })
        }
      }
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
      return newId
    })
    await load()
    publishRevision({ id, kind: 'cover' })
    return id
  }

  /**
   * 合并保存封信息。带 base 时按修订基线三向合并：
   * 互不冲突字段直接并入，同一字段两边改成不同值时保留先保存值并报冲突字段。
   * 不直接改 routeId——改挂接请走 attachToRoute（挂接冲突需要落待裁定）。
   */
  async function save(
    id: number,
    patch: Partial<Cover>,
    base?: Partial<Cover>
  ): Promise<CoverSaveOutcome> {
    const { routeId: _routeId, rev: _rev, ...fieldPatch } = patch
    void _routeId
    void _rev
    const result = await db.transaction('rw', db.covers, async () => {
      const current = await db.covers.get(id)
      if (!current) throw new Error(`实寄封 #${id} 已不存在`)
      const merged = threeWayMerge(
        (base ?? current) as MergePatch,
        current as unknown as MergePatch,
        fieldPatch as MergePatch,
        current.rev + 1
      )
      await db.covers.update(id, { ...merged.patch, updatedAt: nowIso() })
      return merged.conflictFields
    })
    await load()
    publishRevision({ id, kind: 'cover' })
    return { conflictFields: result, routeConflict: null }
  }

  async function remove(id: number): Promise<void> {
    await db.transaction('rw', db.covers, db.stampEntries, db.assets, db.mergeConflicts, async () => {
      await db.covers.delete(id)
      const ownEntries = await db.stampEntries.where('coverId').equals(id).toArray()
      await db.stampEntries.bulkDelete(
        ownEntries.map((e) => e.id).filter((v): v is number => typeof v === 'number')
      )
      const ownAssets = await db.assets.where('ownerId').equals(id).toArray()
      await db.assets.bulkDelete(
        ownAssets
          .filter((a) => a.ownerType === 'cover')
          .map((a) => a.id)
          .filter((v): v is number => typeof v === 'number')
      )
      const ownConflicts = await db.mergeConflicts.where('coverId').equals(id).toArray()
      await db.mergeConflicts.bulkDelete(
        ownConflicts.map((c) => c.id).filter((v): v is number => typeof v === 'number')
      )
    })
    await load()
    publishRevision({ id, kind: 'cover' })
  }

  /**
   * 把封挂到某邮路（或摘除）。这是挂接关系的唯一入口，处理多标签页的并发：
   *
   * - 与先保存者一致（挂同一路 / 重复摘除）→ 幂等并入；
   * - 先保存者把封挂到了别的邮路（仅当本页基线认为它在另一条路上时）→ 不覆盖，
   *   落一条待裁定，保留先保存挂接；
   * - 对一条已挂在本路的封做摘除 → 直接生效（摘除不制造两说）；
   * - 全新挂接 / 从摘除状态挂接 → 直接生效。
   *
   * @returns outcome.routeConflict 非空表示本次挂接被挂起待裁定
   */
  async function attachToRoute(input: {
    coverId: number
    routeId: number | null
    /** 本页操作时认为封「原来挂在哪」；用于判定是否真的与先保存者撞车 */
    expectedFromRouteId?: number | null
    source?: string
  }): Promise<CoverSaveOutcome> {
    const { coverId, routeId, expectedFromRouteId, source } = {
      source: ATTACH_SOURCE,
      ...input
    }
    const now = nowIso()
    const routeConflict = await db.transaction(
      'rw',
      db.covers,
      db.routes,
      db.mergeConflicts,
      async () => {
        const cover = await db.covers.get(coverId)
        if (!cover) throw new Error(`实寄封 #${coverId} 已不存在`)
        const currentRouteId = typeof cover.routeId === 'number' ? cover.routeId : null

        // 已存在未裁定冲突：同一封不重复堆叠，直接返回原冲突。
        const existing = await db.mergeConflicts
          .where('coverId')
          .equals(coverId)
          .filter((c) => !c.resolvedAt)
          .first()
        if (existing) return existing

        // 幂等：库内现状与本页目标一致。
        if (currentRouteId === routeId) return null

        // 撞车判定：本页基线认为的原挂接 ≠ 库内现状（先保存者已改），且两边目标不同。
        const changedByOther =
          expectedFromRouteId !== undefined && expectedFromRouteId !== currentRouteId
        if (changedByOther && routeId !== null && currentRouteId !== null) {
          const [targetRoute, currentRoute] = await Promise.all([
            db.routes.get(routeId),
            db.routes.get(currentRouteId)
          ])
          const winner: RouteClaim = {
            routeId: currentRouteId,
            nodesRev: currentRoute?.nodesRev ?? cover.timelineBaseRev,
            source: '先保存',
            at: now
          }
          const pending: RouteClaim = {
            routeId,
            nodesRev: targetRoute?.nodesRev ?? 1,
            source,
            at: now
          }
          const conflict: MergeConflict = {
            kind: 'coverRoute',
            coverId,
            coverNo: cover.coverNo,
            winner,
            pending,
            baseRev: cover.rev,
            createdAt: now,
            resolvedAt: ''
          }
          const conflictId = await db.mergeConflicts.add(conflict)
          // 封保持先保存挂接，rev 自增；时间轴基线不动（仍对齐先保存的邮路）
          await db.covers.update(coverId, { rev: cover.rev + 1, updatedAt: now })
          return { ...conflict, id: conflictId }
        }

        // 无冲突：直接并入。挂接时按目标邮路当前 nodesRev 补基线；摘除则基线归零。
        let timelineBaseRev = cover.timelineBaseRev
        if (typeof routeId === 'number') {
          const target = await db.routes.get(routeId)
          timelineBaseRev = target ? target.nodesRev : cover.timelineBaseRev
        } else {
          timelineBaseRev = 0
        }
        await db.covers.update(coverId, {
          routeId,
          timelineBaseRev,
          rev: cover.rev + 1,
          updatedAt: now
        })
        return null
      }
    )
    await load()
    publishRevision({ id: coverId, kind: 'cover' })
    if (routeConflict) publishRevision({ id: coverId, kind: 'conflict' })
    return { conflictFields: [], routeConflict }
  }

  /** 新增票戳组合（多标签页各加一条互不覆盖，各自携带基线）。 */
  async function addEntry(input: StamplessEntry): Promise<number> {
    const id = await db.stampEntries.add({
      ...input,
      rev: input.rev > 0 ? input.rev : INITIAL_REV,
      createdAt: nowIso()
    })
    await load()
    publishRevision({ id, kind: 'stampEntry' })
    return id
  }

  /** 票戳组合按基线合并更新（当前页面只有新增/删除，保留供后续编辑）。 */
  async function saveEntry(id: number, patch: Partial<StamplessEntry>): Promise<void> {
    await db.transaction('rw', db.stampEntries, async () => {
      const current = await db.stampEntries.get(id)
      if (!current) throw new Error(`票戳组合 #${id} 已不存在`)
      const merged = threeWayMerge(
        current as unknown as MergePatch,
        current as unknown as MergePatch,
        patch as MergePatch,
        current.rev + 1
      )
      await db.stampEntries.update(id, merged.patch)
    })
    await load()
    publishRevision({ id, kind: 'stampEntry' })
  }

  async function removeEntry(id: number): Promise<void> {
    await db.stampEntries.delete(id)
    await load()
    publishRevision({ id, kind: 'stampEntry' })
  }

  /**
   * 用户在封详情页核对过新时间轴后补基线：把封的 timelineBaseRev 对齐到所挂邮路
   * 当前 nodesRev，时间轴恢复有效、综合检索恢复命中。
   */
  async function rebaselineTimeline(coverId: number): Promise<boolean> {
    const changed = await db.transaction('rw', db.covers, db.routes, async () => {
      const cover = await db.covers.get(coverId)
      if (!cover || typeof cover.routeId !== 'number') return false
      const route = await db.routes.get(cover.routeId)
      if (!route) return false
      if (cover.timelineBaseRev === route.nodesRev) return false
      await db.covers.update(coverId, {
        timelineBaseRev: route.nodesRev,
        rev: cover.rev + 1,
        updatedAt: nowIso()
      })
      return true
    })
    if (changed) {
      await load()
      publishRevision({ id: coverId, kind: 'cover' })
    }
    return changed
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
    load,
    nextCoverNo,
    create,
    save,
    remove,
    attachToRoute,
    addEntry,
    saveEntry,
    removeEntry,
    rebaselineTimeline,
    byId,
    entriesOf,
    frankingCount,
    cancelCount
  }
})
