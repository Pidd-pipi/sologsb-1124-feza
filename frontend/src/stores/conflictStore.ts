import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { MergeConflict } from '@/types/conflict'
import { nowIso } from '@/utils/id'
import { publishRevision } from '@/utils/revisionBus'

/**
 * 待裁定冲突：同一封被两个页面基于同一基线挂到不同邮路时产生。
 * 先保存一方的挂接直接生效，后保存一方的主张落在此处，由人工在邮路页裁决。
 */
export const useConflictStore = defineStore('conflict', () => {
  const list = ref<MergeConflict[]>([])
  const loaded = ref(false)

  async function load(): Promise<void> {
    list.value = await db.mergeConflicts.orderBy('createdAt').reverse().toArray()
    loaded.value = true
  }

  /** 未解决的全部冲突。 */
  const openConflicts = computed(() => list.value.filter((c) => !c.resolvedAt))

  function openConflictOfCover(coverId: number): MergeConflict | null {
    return openConflicts.value.find((c) => c.coverId === coverId) ?? null
  }

  function openConflictsOfRoute(routeId: number): MergeConflict[] {
    return openConflicts.value.filter(
      (c) => c.winner.routeId === routeId || c.pending.routeId === routeId
    )
  }

  function pendingAgainstRoute(routeId: number): MergeConflict[] {
    // 邮路页「待裁定」徽标：本路作为先保存或后保存方卷入未裁定冲突，都需处理
    return openConflicts.value.filter(
      (c) => c.winner.routeId === routeId || c.pending.routeId === routeId
    )
  }

  const openCount = computed(() => openConflicts.value.length)

  /**
   * 裁决一条冲突。
   * @param conflictId 冲突 id
   * @param choose 'winner' 维持先保存挂接；'pending' 改挂后保存方主张的邮路
   */
  async function resolve(
    conflictId: number,
    choose: 'winner' | 'pending'
  ): Promise<{ coverId: number; routeId: number | null; nodesRev: number } | null> {
    const result = await db.transaction(
      'rw',
      db.mergeConflicts,
      db.covers,
      db.routes,
      async () => {
        const conflict = await db.mergeConflicts.get(conflictId)
        if (!conflict || conflict.resolvedAt) return null
        const claim = choose === 'pending' ? conflict.pending : conflict.winner
        const cover = await db.covers.get(conflict.coverId)
        if (cover) {
          const now = nowIso()
          let baseRev = cover.timelineBaseRev
          let routeId = cover.routeId
          if (typeof claim.routeId === 'number') {
            const route = await db.routes.get(claim.routeId)
            // 目标邮路已被删除：无法改挂，抛出错误，冲突保留以便重新选择
            if (!route) throw new Error(`主张的邮路 #${claim.routeId} 已被删除，无法改挂`)
            // 裁决生效时按邮路当前 nodesRev 补基线：时间轴以裁决结果重新对齐
            baseRev = route.nodesRev
            routeId = claim.routeId
          } else {
            routeId = null
            baseRev = 0
          }
          await db.covers.update(conflict.coverId, {
            routeId,
            timelineBaseRev: baseRev,
            rev: (cover.rev || 1) + 1,
            updatedAt: now
          })
        }
        await db.mergeConflicts.update(conflictId, { resolvedAt: nowIso() })
        const coverId = conflict.coverId
        return {
          coverId,
          routeId: choose === 'pending' ? conflict.pending.routeId : conflict.winner.routeId,
          nodesRev: choose === 'pending' ? conflict.pending.nodesRev : conflict.winner.nodesRev
        }
      }
    )
    await load()
    publishRevision({ id: result?.coverId ?? 0, kind: 'conflict' })
    publishRevision({ id: result?.coverId ?? 0, kind: 'cover' })
    return result
  }

  /** 封被删除时清理其冲突记录。 */
  async function removeForCover(coverId: number): Promise<void> {
    const own = await db.mergeConflicts.where('coverId').equals(coverId).toArray()
    if (own.length) {
      await db.mergeConflicts.bulkDelete(own.map((c) => c.id).filter((v): v is number => typeof v === 'number'))
      await load()
    }
  }

  return {
    list,
    loaded,
    openConflicts,
    openCount,
    load,
    openConflictOfCover,
    openConflictsOfRoute,
    pendingAgainstRoute,
    resolve,
    removeForCover
  }
})
