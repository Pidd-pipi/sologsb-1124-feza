/**
 * IndexedDB 端到端冒烟测试（fake-indexeddb）：
 * 1. v2 旧库升级到 v3 后自动补修订基线；
 * 2. 同一封被两页挂到不同邮路 → 落待裁定、保留先保存；
 * 3. 节点改动 → nodesRev 自增、挂接封时间轴立即失效；
 * 4. 裁决/补基线后恢复。
 */
import { createPinia, setActivePinia } from 'pinia'
import Dexie from 'dexie'

import { DB_NAME, db } from '../src/utils/db'
import { useRouteStore } from '../src/stores/routeStore'
import { useCoverStore } from '../src/stores/coverStore'
import { useConflictStore } from '../src/stores/conflictStore'
import { isTimelineStale } from '../src/utils/timelineStatus'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failures += 1
    console.error(`  ✗ ${msg}`)
  }
}

async function buildV2Database(): Promise<void> {
  const old = new Dexie(DB_NAME)
  old.version(1).stores({
    postmarks: '++id, pmNo, type, office, province, yearFrom, yearTo, scarceLevel',
    covers: '++id, coverNo, sentFrom, sentTo, postDate, conditionGrade, registered',
    routes: '++id, routeNo, name, era, transport',
    stampEntries: '++id, coverId, stampName, variety',
    assets: '++id, ownerType, ownerId, side'
  })
  old.version(2).stores({
    postmarks:
      '++id, pmNo, type, office, province, yearFrom, yearTo, scarceLevel, inkColor, bilingual',
    covers:
      '++id, coverNo, sentFrom, sentTo, postDate, conditionGrade, registered, routeId, acquireFrom',
    routes: '++id, routeNo, name, era, transport, totalDays',
    stampEntries: '++id, coverId, stampName, variety, issueYear',
    assets: '++id, ownerType, ownerId, side, [ownerType+ownerId]'
  })
  await old.table('routes').bulkAdd([
    {
      id: 1,
      routeNo: 'RT-1',
      name: '甲路',
      era: '1910',
      transport: '铁路',
      nodes: [{ key: 'n1', office: '上海', arriveDate: '1910-01-01', transitMark: '' }],
      totalDays: 0,
      frequency: '',
      remark: '',
      createdAt: '',
      updatedAt: ''
    },
    {
      id: 2,
      routeNo: 'RT-2',
      name: '乙路',
      era: '1920',
      transport: '船运',
      nodes: [],
      totalDays: 0,
      frequency: '',
      remark: '',
      createdAt: '',
      updatedAt: ''
    }
  ])
  await old.table('covers').bulkAdd([
    {
      id: 1,
      coverNo: 'CV-1',
      sentFrom: '上海',
      sentTo: '南京',
      postDate: '1910-01-01',
      arriveDate: '',
      franking: [],
      cancelPmIds: [],
      routeId: 1,
      viaPoints: [],
      registered: false,
      conditionGrade: '中品',
      acquireFrom: '',
      price: 0,
      storageAlbum: '',
      frontImage: '',
      backImage: '',
      note: '',
      createdAt: '',
      updatedAt: ''
    }
  ])
  await old.close()
}

async function main(): Promise<void> {
  console.log('v2 → v3 升级补基线：')
  await buildV2Database()
  await db.open()
  const route1 = await db.routes.get(1)
  const route2 = await db.routes.get(2)
  const cover1 = await db.covers.get(1)
  assert(route1.rev === 1 && route1.nodesRev === 1, '旧邮路补齐 rev=1 / nodesRev=1')
  assert(cover1.rev === 1, '旧实寄封补齐 rev=1')
  assert(
    cover1.timelineBaseRev === route1.nodesRev,
    '已挂接封的时间轴基线对齐所属邮路当前 nodesRev（升级后不被误判失效）'
  )

  setActivePinia(createPinia())
  const routeStore = useRouteStore()
  const coverStore = useCoverStore()
  const conflictStore = useConflictStore()
  await Promise.all([routeStore.load(), coverStore.load(), conflictStore.load()])

  console.log('同封两页挂到不同邮路 → 待裁定：')
  // 标签页 B 先把封从甲路挂到乙路（此时封的基线是甲路）
  await coverStore.attachToRoute({ coverId: 1, routeId: 2, expectedFromRouteId: 1 })
  let cover = await db.covers.get(1)
  assert(cover.routeId === 2, '先保存挂接（乙路）生效')
  // 标签页 A 基于旧基线（仍以为封在甲路）把封挂到一个不存在冲突的目标——模拟挂到「丙路」:
  // 用乙路再撞一次：A 以为封在甲路(1)，库里是乙路(2)，A 要挂到... 选另一条路 id=1(甲路)
  const outcome = await coverStore.attachToRoute({
    coverId: 1,
    routeId: 1,
    expectedFromRouteId: 1
  })
  cover = await db.covers.get(1)
  assert(!!outcome.routeConflict, '后保存挂接未覆盖，产生待裁定')
  assert(cover.routeId === 2, '待裁定期间保留先保存挂接（仍是乙路）')
  await conflictStore.load()
  assert(conflictStore.openCount === 1, '冲突表中恰有一条未裁定记录')
  assert(
    isTimelineStale(
      cover,
      await db.routes.get(2),
      conflictStore.openConflictOfCover(1) != null
    ) === true,
    '待裁定未决时时间轴失效、搜索应暂停'
  )

  console.log('节点改动立即失效：')
  const conflict0 = conflictStore.openConflicts[0]
  await conflictStore.resolve(conflict0.id as number, 'winner') // 裁定维持乙路
  await coverStore.load()
  cover = await db.covers.get(1)
  assert(cover.routeId === 2, '裁决维持先保存 → 仍挂乙路')
  let rt2 = await db.routes.get(2)
  assert(cover.timelineBaseRev === rt2.nodesRev, '裁决后基线对齐乙路当前 nodesRev')
  // 乙路新增节点
  await routeStore.addNode(2, { key: 'x', office: '汉口', arriveDate: '1921-05-01', transitMark: '' })
  cover = await db.covers.get(1)
  rt2 = await db.routes.get(2)
  assert(rt2.nodesRev === 2, '节点改动后 nodesRev 自增到 2')
  assert(cover.timelineBaseRev === 1, '挂接封基线仍停在 1（未自动跟进）')
  assert(isTimelineStale(cover, rt2) === true, '节点改动后挂接封时间轴立即失效')

  console.log('核对补基线后恢复：')
  const revived = await coverStore.rebaselineTimeline(1)
  cover = await db.covers.get(1)
  assert(revived && cover.timelineBaseRev === 2, '补基线后时间轴恢复有效、检索恢复命中')
  assert(isTimelineStale(cover, rt2) === false, '失效标记消除')

  await db.close()
  if (failures) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部通过')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
