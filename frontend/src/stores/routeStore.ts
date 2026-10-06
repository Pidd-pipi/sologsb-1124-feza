import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { PostalRoute, RouteNode } from '@/types/route'
import { INITIAL_REV } from '@/types/route'
import { daysBetween, isValidDate } from '@/utils/dateRange'
import { nextSerialNo, nowIso, uid } from '@/utils/id'
import { threeWayMerge, type MergePatch } from '@/utils/revision'
import { publishRevision } from '@/utils/revisionBus'

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

export interface RouteSaveOutcome {
  conflictFields: string[]
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

  /**
   * 合并保存邮路信息（非节点字段）。带 base 时按三向合并：
   * 互不冲突的改动直接并入；同一字段被两边改成不同值时保留先保存值并报冲突。
   * 不触碰 nodesRev，因此不会使挂接封时间轴失效。
   */
  async function save(
    id: number,
    patch: Partial<PostalRoute>,
    base?: Partial<PostalRoute>
  ): Promise<RouteSaveOutcome> {
    const { nodes: _nodes, ...headerPatch } = patch
    void _nodes
    const conflictFields = await db.transaction('rw', db.routes, async () => {
      const current = await db.routes.get(id)
      if (!current) throw new Error(`邮路 #${id} 已不存在`)
      const merged = threeWayMerge(
        (base ?? current) as MergePatch,
        current as unknown as MergePatch,
        headerPatch as MergePatch,
        current.rev + 1
      )
      await db.routes.update(id, { ...merged.patch, updatedAt: nowIso() })
      return merged.conflictFields
    })
    await load()
    publishRevision({ id, kind: 'route' })
    return { conflictFields }
  }

  /** 新建邮路。 */
  async function create(input: PostalRoute): Promise<number> {
    const now = nowIso()
    const record: PostalRoute = {
      ...input,
      routeNo: input.routeNo || nextRouteNo(),
      nodes: input.nodes.map((n) => ({ ...n, key: n.key || uid('node') })),
      totalDays: computeTotalDays(input.nodes),
      rev: INITIAL_REV,
      nodesRev: INITIAL_REV,
      createdAt: now,
      updatedAt: now
    }
    delete record.id
    const id = await db.routes.add(record)
    await load()
    publishRevision({ id, kind: 'route', nodesChanged: true })
    return id
  }

  async function remove(id: number): Promise<void> {
    await db.transaction('rw', db.routes, db.covers, async () => {
      await db.routes.delete(id)
      // 摘除挂在该邮路上的封：挂接对象消失，时间轴随之失效待重新挂接。
      await db.covers.where('routeId').equals(id).modify({ routeId: null })
    })
    await load()
    publishRevision({ id, kind: 'route', nodesChanged: true })
  }

  /**
   * 提交一组新节点（增删 / 排序 / 改日期都走这里）。
   * 节点结构一旦改变：邮路 rev 与 nodesRev 同时自增，所有挂接封的时间轴基线
   * 立刻落后于 nodesRev —— 时间轴立即失效，无需等待任何页面刷新。
   * 若节点与库内完全一致（如仅重算天数），不会推高 nodesRev。
   */
  async function commitNodes(id: number, nextNodes: RouteNode[]): Promise<{ invalidated: number }> {
    const result = await db.transaction('rw', db.routes, db.covers, async () => {
      const current = await db.routes.get(id)
      if (!current) throw new Error(`邮路 #${id} 已不存在`)
      const same = JSON.stringify(current.nodes) === JSON.stringify(nextNodes)
      const now = nowIso()
      if (same) {
        await db.routes.update(id, { totalDays: computeTotalDays(nextNodes), updatedAt: now })
        return 0
      }
      const nodesRev = current.nodesRev + 1
      await db.routes.update(id, {
        nodes: nextNodes,
        totalDays: computeTotalDays(nextNodes),
        rev: current.rev + 1,
        nodesRev,
        updatedAt: now
      })
      // 挂接封基线立刻落后：逐条把封 rev 自增，时间轴待用户核对后补基线。
      const attached = await db.covers.where('routeId').equals(id).toArray()
      for (const cover of attached) {
        await db.covers.update(cover.id as number, {
          rev: (cover.rev || 1) + 1,
          updatedAt: now
        })
      }
      return attached.length
    })
    await load()
    publishRevision({ id, kind: 'route', nodesChanged: true })
    return { invalidated: result }
  }

  /** 节点拖拽排序。 */
  async function moveNode(id: number, from: number, to: number): Promise<void> {
    const current = byId(id)
    if (!current) return
    const nodes = current.nodes.map((n) => ({ ...n }))
    if (from < 0 || from >= nodes.length || to < 0 || to >= nodes.length || from === to) return
    const [moved] = nodes.splice(from, 1)
    nodes.splice(to, 0, moved)
    await commitNodes(id, nodes)
  }

  /** 新增中转节点，可指定插入位置（按索引，调用前基于当前列表）。 */
  async function addNode(id: number, node: RouteNode, index?: number): Promise<void> {
    const current = byId(id)
    if (!current) return
    const nodes = current.nodes.map((n) => ({ ...n }))
    nodes.splice(index == null ? nodes.length : index, 0, { ...node, key: node.key || uid('node') })
    await commitNodes(id, nodes)
  }

  async function removeNode(id: number, key: string): Promise<void> {
    const current = byId(id)
    if (!current) return
    await commitNodes(
      id,
      current.nodes.filter((n) => n.key !== key).map((n) => ({ ...n }))
    )
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
    save,
    remove,
    commitNodes,
    moveNode,
    addNode,
    removeNode,
    byId,
    missingDateCount
  }
})
