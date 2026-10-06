/**
 * 由实寄封与邮路节点拼出寄递时间轴，并计算在途天数。
 * 被封详情页与邮路编辑器复用。
 *
 * 数据取自 cover / route 两个 store（响应式）：邮路节点一旦改动，
 * 依赖该邮路的封的时间轴立即判为失效，无需重新拉取。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Cover } from '@/types/cover'
import type { PostalRoute, TimelineNode } from '@/types/route'
import type { PendingRouteLink } from '@/types/link'
import { daysBetween, isValidDate } from '@/utils/dateRange'
import { isTimelineStale } from '@/utils/revision'
import { useCoverStore } from '@/stores/coverStore'
import { useRouteStore } from '@/stores/routeStore'

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

export interface PendingCandidate {
  link: PendingRouteLink
  route: PostalRoute | null
}

export function useCoverRoute(coverId: Ref<number | null> | ComputedRef<number | null>) {
  const coverStore = useCoverStore()
  const routeStore = useRouteStore()

  const loading = ref(false)
  const error = ref('')

  async function load(): Promise<void> {
    loading.value = true
    try {
      if (!coverStore.loaded) await coverStore.load()
      if (!routeStore.loaded) await routeStore.load()
      const id = coverId.value
      error.value = id == null ? '' : coverStore.byId(id) ? '' : `未找到编号为 ${id} 的实寄封`
    } finally {
      loading.value = false
    }
  }

  watch(coverId, () => void load(), { immediate: true })

  const cover = computed<Cover | null>(() => coverStore.byId(coverId.value))
  const route = computed<PostalRoute | null>(() =>
    cover.value ? routeStore.byId(cover.value.routeId) : null
  )

  /** 节点改动 / 待裁定 → 时间轴立即失效。 */
  const stale = computed<boolean>(() => isTimelineStale(cover.value, route.value))
  const hasPending = computed<boolean>(() => (cover.value?.pendingRouteLinks?.length ?? 0) > 0)

  /** 待裁定候选（带上邮路信息供页面渲染）。 */
  const pendingCandidates = computed<PendingCandidate[]>(() => {
    const links = cover.value?.pendingRouteLinks ?? []
    return links.map((link) => ({ link, route: routeStore.byId(link.routeId) }))
  })

  const timeline = computed<TimelineNode[]>(() =>
    stale.value ? [] : buildTimeline(cover.value, route.value)
  )

  /** 在途天数：寄出日期 → 到达日期 */
  const transitDays = computed<number | null>(() => {
    if (!cover.value) return null
    return daysBetween(cover.value.postDate, cover.value.arriveDate)
  })

  /** 缺少日期的节点，供缺日警示使用 */
  const missingDateNodes = computed<TimelineNode[]>(() =>
    timeline.value.filter((n) => !isValidDate(n.date))
  )

  /** 节点日期是否单调不减 */
  const chronological = computed<boolean>(() => {
    const dated = timeline.value.filter((n) => isValidDate(n.date))
    for (let i = 1; i < dated.length; i += 1) {
      if (dated[i - 1].date > dated[i].date) return false
    }
    return true
  })

  return {
    cover,
    route,
    stale,
    hasPending,
    pendingCandidates,
    timeline,
    transitDays,
    missingDateNodes,
    chronological,
    loading,
    error,
    load
  }
}
