/**
 * 派生状态的唯一出口：封详情的寄递时间轴与综合检索的年代判定都从这里取结果，
 * 保证「时间轴看到的年代」与「搜索命中的年代」永远是同一套，不允许各算各的。
 */
import type { Cover } from '@/types/cover'
import type { PostalRoute } from '@/types/route'
import { isValidDate } from '@/utils/dateRange'

/**
 * 封的寄递时间轴是否失效。
 *
 * 规则：挂接邮路的节点一旦改动（邮路 nodesRev 自增），所有基线未跟进的挂接封
 * 时间轴立即失效；待裁定冲突未解决前同样视为失效。未挂邮路（无节点可依赖）
 * 的封不会失效。
 */
export function isTimelineStale(
  cover: Cover | null | undefined,
  route: PostalRoute | null | undefined,
  hasPendingConflict = false
): boolean {
  if (!cover) return false
  // 待裁定冲突未解决前，挂接关系本身有两说，时间轴暂停采信。
  if (hasPendingConflict) return true
  if (typeof cover.routeId !== 'number') return false
  // 挂接的邮路已不存在：基线无从对齐，按失效处理。
  if (!route) return true
  return cover.timelineBaseRev !== route.nodesRev
}

/**
 * 封的检索代表年份：时间轴有效时取首个节点日期的年份（与时间轴同源），
 * 否则回退到封的寄出年份，并通过返回值标明是否为回退值。
 */
export function coverTimelineStartYear(
  cover: Cover,
  route: PostalRoute | null | undefined
): { year: number; derived: boolean } {
  if (route && typeof cover.routeId === 'number') {
    for (const node of route.nodes) {
      if (isValidDate(node.arriveDate)) {
        return { year: Number(node.arriveDate.slice(0, 4)) || 0, derived: true }
      }
    }
  }
  const year = cover.postDate ? Number(cover.postDate.slice(0, 4)) || 0 : 0
  return { year, derived: false }
}

/** 某条邮路改动节点后，挂在它下面的封是否需要立即标记失效。 */
export function coverDependsOnRoute(cover: Cover, routeId: number): boolean {
  return cover.routeId === routeId
}
