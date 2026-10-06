// 验证从 v2（无修订基线）升级到 v3 后，历史数据被正确补齐基线且既有时间轴不失效。
import 'fake-indexeddb/auto'

async function setupV2Data(): Promise<void> {
  // 按应用 v2 结构手工建一个旧库并写入缺基线字段的历史数据
  const { default: Dexie } = await import('dexie')
  const old = new Dexie('gbpostmark')
  old.version(2).stores({
    postmarks:
      '++id, pmNo, type, office, province, yearFrom, yearTo, scarceLevel, inkColor, bilingual',
    covers:
      '++id, coverNo, sentFrom, sentTo, postDate, conditionGrade, registered, routeId, acquireFrom',
    routes: '++id, routeNo, name, era, transport, totalDays',
    stampEntries: '++id, coverId, stampName, variety, issueYear',
    assets: '++id, ownerType, ownerId, side, [ownerType+ownerId]'
  })
  await old.table('postmarks').add({
    id: 1,
    pmNo: 'PM-0001',
    type: '圆形日戳',
    office: '上海邮政总局',
    province: '上海',
    yearFrom: 1908,
    yearTo: 1912,
    dateOnStamp: '1910-06-18',
    inkColor: '黑',
    diameter: 26,
    lettering: { top: '上海', middle: 'SHANGHAI', bottom: '' },
    bilingual: true,
    scarceLevel: '少见',
    imageDataUrl: '',
    note: '',
    createdAt: 'x',
    updatedAt: 'x'
  })
  await old.routes.add({
    id: 1,
    routeNo: 'RT-0001',
    name: '旧邮路',
    era: '1910-1919',
    transport: '铁路',
    nodes: [{ key: 'n1', office: '上海', arriveDate: '1910-06-18', transitMark: '日戳' }],
    totalDays: 0,
    frequency: '逐日班',
    remark: '',
    createdAt: 'x',
    updatedAt: 'x'
  })
  await old.covers.add({
    id: 1,
    coverNo: 'CV-0001',
    sentFrom: '上海',
    sentTo: '南京',
    postDate: '1910-06-18',
    arriveDate: '1910-06-21',
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
    createdAt: 'x',
    updatedAt: 'x'
  })
  await old.covers.add({
    id: 2,
    coverNo: 'CV-0002',
    sentFrom: '天津',
    sentTo: '北京',
    postDate: '1921-03-05',
    arriveDate: '',
    franking: [],
    cancelPmIds: [],
    routeId: null,
    viaPoints: [],
    registered: false,
    conditionGrade: '中品',
    acquireFrom: '',
    price: 0,
    storageAlbum: '',
    frontImage: '',
    backImage: '',
    note: '',
    createdAt: 'x',
    updatedAt: 'x'
  })
  await old.stampEntries.add({
    id: 1,
    coverId: 1,
    stampName: '帆船邮票',
    denomination: 4,
    issueYear: 1913,
    perforation: 'P14',
    variety: '正品',
    positionOnCover: '右上',
    createdAt: 'x'
  })
  await old.close()
}

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1
    console.error('FAIL:', msg)
  } else console.log('ok  :', msg)
}

await setupV2Data()

// 打开当前版本（v3），触发升级迁移
const { db, initDatabase } = await import('../src/utils/db')
await initDatabase()

const routes = await db.routes.toArray()
const covers = await db.covers.toArray()
const entries = await db.stampEntries.toArray()

const rt = routes.find((x) => x.id === 1)!
assert(rt.revision === 1, '旧邮路补 revision=1')
assert(rt.nodesRevision === 1, '旧邮路带节点 → nodesRevision=1（升级本身不触发失效）')
assert(rt.nodesChangedAt === '', '旧邮路 nodesChangedAt 兜底为空串')

const c1 = covers.find((x) => x.id === 1)!
assert(c1.revision === 1, '旧封补 revision=1')
assert(c1.linkedNodesRevision === 1, '挂在带节点邮路上的旧封基线对齐=1（升级后不立即失效）')
assert(Array.isArray(c1.pendingRouteLinks) && c1.pendingRouteLinks.length === 0, '旧封待裁定列表为空数组')

const c2 = covers.find((x) => x.id === 2)!
assert(c2.linkedNodesRevision === 0 && c2.pendingRouteLinks.length === 0, '未挂邮路的旧封基线为 0、无待裁定')

const se = entries.find((x) => x.id === 1)!
assert(se.revision === 1, '旧票戳组合补 revision=1')

await db.close()

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\nDB v2→v3 升级迁移断言通过')
