/**
 * 核心逻辑运行时校验：三向合并 / 时间轴失效 / 检索代表年份。
 * 用法：npx tsx scripts/check-revision.mts（不进入应用构建）。
 */
import { threeWayMerge } from '../src/utils/revision'
import { isTimelineStale, coverTimelineStartYear } from '../src/utils/timelineStatus'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures += 1
    console.error(`  ✗ ${msg}`)
  }
}

console.log('三向合并：')
{
  const base = { name: '沪宁', remark: '旧', era: '1910s' }
  const current = { name: '沪宁铁路', remark: '旧', era: '清末' } // 先保存方改了 name、era
  const incoming = { name: '沪宁铁路', remark: '新备注', era: '1920s' } // 我方改了 remark、era
  const r = threeWayMerge(base, current, incoming, 3)
  assert(r.patch.name === '沪宁铁路', 'name 我方未改，沿用先保存值')
  assert(r.patch.remark === '新备注', '互不冲突的 remark 直接并入')
  assert(r.conflictFields.length === 1 && r.conflictFields[0] === 'era', '仅 era 记为冲突')
  assert(r.patch.era === '清末', '冲突字段 era 保留先保存值')
  assert(r.patch.rev === 3, '合并后 rev 自增到传入的下一个修订号')
}

console.log('互不冲突双向改动并入：')
{
  const base = { a: 1, b: 1 }
  const current = { a: 2, b: 1 } // 对方改 a
  const incoming = { a: 1, b: 2 } // 我方改 b
  const r = threeWayMerge(base, current, incoming, 2)
  assert(r.patch.a === 2, '对方的 a 并入')
  assert(r.patch.b === 2, '我方的 b 并入')
  assert(r.conflictFields.length === 0, '无冲突字段')
}

console.log('时间轴失效：')
{
  const cover = { routeId: 1, timelineBaseRev: 2 } as any
  const routeA = { id: 1, nodesRev: 2 } as any
  const routeB = { id: 1, nodesRev: 3 } as any
  assert(isTimelineStale(cover, routeA) === false, '基线一致 → 有效')
  assert(isTimelineStale(cover, routeB) === true, '节点改动后 nodesRev 超前 → 立即失效')
  assert(isTimelineStale(cover, routeA, true) === true, '挂接待裁定 → 失效/暂停')
  assert(isTimelineStale({ routeId: null, timelineBaseRev: 0 } as any, null) === false, '未挂邮路不失效')
  assert(isTimelineStale(cover, null) === true, '挂接邮路已消失 → 失效')
}

console.log('检索年份与时间轴同源：')
{
  const cover = { postDate: '1999-01-01', routeId: 1 } as any
  const route = { nodes: [{ arriveDate: '1910-06-18' }, { arriveDate: '1910-06-21' }] } as any
  const y = coverTimelineStartYear(cover, route)
  assert(y.year === 1910 && y.derived === true, '挂接时取首节点年份（与时间轴同源）')
  const y2 = coverTimelineStartYear(cover, null)
  assert(y2.year === 1999 && y2.derived === false, '无邮路回退寄出年份')
}

if (failures) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部通过')
