import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { PostalRoute, RouteNode } from '@/types/route'
import { daysBetween, isValidDate } from '@/utils/dateRange'
import { nextSerialNo, nowIso, uid } from '@/utils/id'
import { nextRevision } from '@/utils/revision'
import { withRecover } from '@/utils/recover'

/** 由节点日期计算全程天数：取首个与末个有效日期的间隔。 */
export function computeTotalDays(nodes: RouteNode[]): number {
  const dated = nodes.filter((n) => isValidDate(n.arriveDate))
  if (dated.length < 2) return 0
  const span = daysBetween(dated[0].arriveDate, dated[dated.length - 1].arriveDate)
  return span == null || span < 0 ? 0 : span
}

/** 新建节点。 */
export function createRouteNode(office = '', arriveDate = '', transitMark = ''): RouteNode {
  return { key: uid('node'), office, arriveDate, transitMark }
}

export const useRouteStore = defineStore('route', () => {
  const list = ref<PostalRoute[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.routes.orderBy('routeNo').toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  function nextRouteNo(): string {
    return nextSerialNo('RT-', list.value.map((r) => r.routeNo))
  }

  async function create(input: PostalRoute): Promise<number> {
    const now = nowIso()
    const hasNodes = input.nodes.length > 0
    const record: PostalRoute = {
      ...input,
      routeNo: input.routeNo || nextRouteNo(),
      nodes: input.nodes.map((n) => ({ ...n, key: n.key || uid('node') })),
      totalDays: computeTotalDays(input.nodes),
      revision: nextRevision(input.revision),
      nodesRevision: hasNodes ? 1 : 0,
      nodesChangedAt: hasNodes ? now : '',
      createdAt: now,
      updatedAt: now
    }
    delete record.id
    const snapshot = null
    const id = await withRecover(
      { id: null, scope: 'route', attempted: record, snapshot },
      async () => {
        const newId = await db.routes.add(record)
        return newId
      }
    )
    await load()
    return id
  }

  /**
   * 保存邮路。
   * @param nodesTouched 是否动了节点（增删 / 拖拽 / 改日期戳记）；
   *        为 true 时推进 nodesRevision，使挂上的封时间轴立即失效。
   */
  async function update(
    id: number,
    patch: Partial<PostalRoute>,
    opts: { nodesTouched?: boolean } = {}
  ): Promise<void> {
    const before = await db.routes.get(id)
    const now = nowIso()
    await withRecover(
      { id, scope: 'route', attempted: { ...(before ?? {}), ...patch, id }, snapshot: before ?? null },
      async () => {
        if (!before) throw new Error(`邮路 ${id} 不存在，保存已回滚`)
        const next: Partial<PostalRoute> = { ...patch, updatedAt: now }
        if (patch.nodes) next.totalDays = computeTotalDays(patch.nodes)
        next.revision = nextRevision(before.revision)
        if (opts.nodesTouched) {
          next.nodesRevision = nextRevision(before.nodesRevision)
          next.nodesChangedAt = now
        }
        await db.routes.update(id, next)
      }
    )
    await load()
  }

  async function remove(id: number): Promise<void> {
    const before = await db.routes.get(id)
    await withRecover(
      { id, scope: 'route', attempted: { deleted: true }, snapshot: before },
      async () => {
        await db.routes.delete(id)
      }
    )
    await load()
  }

  /** 节点拖拽排序（动节点 → 时间轴失效） */
  async function moveNode(id: number, from: number, to: number): Promise<void> {
    const route = byId(id)
    if (!route) return
    const nodes = route.nodes.map((n) => ({ ...n }))
    if (from < 0 || from >= nodes.length || to < 0 || to >= nodes.length || from === to) return
    const [moved] = nodes.splice(from, 1)
    nodes.splice(to, 0, moved)
    await update(id, { nodes }, { nodesTouched: true })
  }

  /** 新增中转节点，可指定插入位置 */
  async function addNode(id: number, node: RouteNode, index?: number): Promise<void> {
    const route = byId(id)
    if (!route) return
    const nodes = route.nodes.map((n) => ({ ...n }))
    nodes.splice(index == null ? nodes.length : index, 0, { ...node })
    await update(id, { nodes }, { nodesTouched: true })
  }

  async function removeNode(id: number, key: string): Promise<void> {
    const route = byId(id)
    if (!route) return
    await update(id, { nodes: route.nodes.filter((n) => n.key !== key) }, { nodesTouched: true })
  }

  /** 仅按现有节点重算全程天数，不改动节点、不使时间轴失效。 */
  async function recalcDays(id: number): Promise<number> {
    const route = byId(id)
    if (!route) return 0
    const totalDays = computeTotalDays(route.nodes)
    const before = await db.routes.get(id)
    await withRecover(
      {
        id,
        scope: 'route',
        attempted: { totalDays },
        snapshot: before ?? null
      },
      async () => {
        await db.routes.update(id, { totalDays, updatedAt: nowIso() })
      }
    )
    await load()
    return totalDays
  }

  function byId(id: number | null | undefined): PostalRoute | null {
    if (id == null) return null
    return list.value.find((r) => r.id === id) ?? null
  }

  /** 缺少日期的节点数，供缺日警示使用 */
  function missingDateCount(route: PostalRoute | null): number {
    if (!route) return 0
    return route.nodes.filter((n) => !isValidDate(n.arriveDate)).length
  }

  const total = computed(() => list.value.length)

  return {
    list,
    loading,
    loaded,
    total,
    load,
    nextRouteNo,
    create,
    update,
    remove,
    moveNode,
    addNode,
    removeNode,
    recalcDays,
    byId,
    missingDateCount
  }
})
