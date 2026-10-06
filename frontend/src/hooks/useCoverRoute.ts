/**
 * 由实寄封与邮路节点拼出寄递时间轴，并计算在途天数。
 * 被封详情页与邮路编辑器复用。
 *
 * 数据统一从 Pinia store 读取：任一标签页改了邮路节点或封挂接，store 收到
 * 修订通知后重载，这里的时间轴与失效标记会立即重算，无需手动刷新。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Cover } from '@/types/cover'
import type { PostalRoute, TimelineNode } from '@/types/route'
import { daysBetween, isValidDate } from '@/utils/dateRange'
import { isTimelineStale } from '@/utils/timelineStatus'
import { useCoverStore } from '@/stores/coverStore'
import { useRouteStore } from '@/stores/routeStore'
import { useConflictStore } from '@/stores/conflictStore'

/** 由封与邮路拼时间轴：寄出 → 中转（邮路节点 / 中转地） → 到达。 */
export function buildTimeline(cover: Cover | null, route: PostalRoute | null): TimelineNode[] {
  if (!cover) return []
  const nodes: TimelineNode[] = [
    {
      key: 'sent',
      label: '寄出',
      office: cover.sentFrom || '寄出地待考',
      date: cover.postDate,
      mark: '收寄日戳',
      kind: 'sent'
    }
  ]

  const transit: TimelineNode[] = []
  if (route && route.nodes.length) {
    for (const node of route.nodes) {
      const isFirst = node.office === cover.sentFrom
      const isLast = node.office === cover.sentTo
      if (isFirst) continue
      transit.push({
        key: node.key,
        label: isLast ? '到达' : '中转',
        office: node.office || '节点待补',
        date: node.arriveDate,
        mark: node.transitMark || '中转戳待补',
        kind: isLast ? 'arrive' : 'transit'
      })
    }
  } else {
    cover.viaPoints.forEach((point, index) => {
      transit.push({
        key: `via-${index}`,
        label: '中转',
        office: point,
        date: '',
        mark: '中转戳待考',
        kind: 'transit'
      })
    })
  }

  const hasArrive = transit.some((n) => n.kind === 'arrive')
  nodes.push(...transit)
  if (!hasArrive) {
    nodes.push({
      key: 'arrive',
      label: '到达',
      office: cover.sentTo || '收件地待考',
      date: cover.arriveDate,
      mark: '到达戳',
      kind: 'arrive'
    })
  } else {
    const last = nodes[nodes.length - 1]
    if (!last.date && cover.arriveDate) last.date = cover.arriveDate
  }
  return nodes
}

export function useCoverRoute(coverId: Ref<number | null> | ComputedRef<number | null>) {
  const coverStore = useCoverStore()
  const routeStore = useRouteStore()
  const conflictStore = useConflictStore()
  const loading = ref(false)
  const error = ref('')

  const cover = computed<Cover | null>(() => coverStore.byId(coverId.value))
  const route = computed<PostalRoute | null>(() =>
    cover.value && typeof cover.value.routeId === 'number'
      ? routeStore.byId(cover.value.routeId)
      : null
  )

  /** 该封是否存在未裁定的「挂到不同邮路」冲突。 */
  const pendingConflict = computed(() =>
    coverId.value == null ? null : conflictStore.openConflictOfCover(coverId.value)
  )

  /**
   * 时间轴是否失效：挂接邮路节点改动后基线未跟进，或挂接本身待裁定。
   * 失效期间封详情给出醒目提示、综合检索暂停该封命中。
   */
  const stale = computed(() =>
    isTimelineStale(cover.value, route.value, pendingConflict.value != null)
  )

  async function load(): Promise<void> {
    const id = coverId.value
    if (id == null || Number.isNaN(id)) {
      error.value = id == null ? '' : '封号无效'
      return
    }
    loading.value = true
    try {
      await Promise.all([
        coverStore.loaded ? Promise.resolve() : coverStore.load(),
        routeStore.loaded ? Promise.resolve() : routeStore.load(),
        conflictStore.loaded ? Promise.resolve() : conflictStore.load()
      ])
      const found = coverStore.byId(id)
      error.value = found ? '' : `未找到编号为 ${id} 的实寄封`
    } finally {
      loading.value = false
    }
  }

  watch(coverId, () => void load(), { immediate: true })

  const timeline = computed<TimelineNode[]>(() => buildTimeline(cover.value, route.value))

  /** 在途天数：寄出日期 → 到达日期 */
  const transitDays = computed<number | null>(() => {
    if (!cover.value) return null
    return daysBetween(cover.value.postDate, cover.value.arriveDate)
  })

  /** 缺少日期的节点，供缺日警示使用（时间轴失效时不重复报缺日，先报失效） */
  const missingDateNodes = computed<TimelineNode[]>(() =>
    stale.value ? [] : timeline.value.filter((n) => !isValidDate(n.date))
  )

  /** 节点日期是否单调不减（失效期间不判定，避免拿旧时间轴误导） */
  const chronological = computed<boolean>(() => {
    if (stale.value) return true
    const dated = timeline.value.filter((n) => isValidDate(n.date))
    for (let i = 1; i < dated.length; i += 1) {
      if (dated[i - 1].date > dated[i].date) return false
    }
    return true
  })

  /** 核对后补基线：时间轴恢复有效、搜索恢复命中。待裁定未决时不允许补。 */
  async function revalidate(): Promise<boolean> {
    const id = coverId.value
    if (id == null || pendingConflict.value) return false
    return coverStore.rebaselineTimeline(id)
  }

  return {
    cover,
    route,
    timeline,
    transitDays,
    missingDateNodes,
    chronological,
    stale,
    pendingConflict,
    revalidate,
    loading,
    error,
    load
  }
}
