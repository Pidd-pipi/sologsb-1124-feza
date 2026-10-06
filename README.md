# 邮戳与实寄封编目台（gbpostmark）

面向邮品收藏者与邮政史研究者：为邮戳、邮路和实寄封建编目，记录戳型、使用年代、邮路节点与封上票戳组合，并以时间轴还原一封邮件的实际寄递过程。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21824>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21824 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`postmarkStore` / `coverStore` / `routeStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地数据 | IndexedDB（Dexie，含版本号与升级迁移）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Postmark 邮戳 | `frontend/src/types/postmark.ts` | 编目号、戳型、局所、省份、使用年代、戳面日期、墨色、戳径、戳面文字、中英双文字、稀见度、戳样图、备注 |
| Cover 实寄封 | `frontend/src/types/cover.ts` | 封号、寄出/收件地、寄出/到达日期、贴票构成、关联邮戳、邮路、中转地、给据、品相、来源、购入价、藏册页位 |
| PostalRoute 邮路 | `frontend/src/types/route.ts` | 邮路号、名称、时期、运输方式、节点数组（局所/到达日期/中转戳）、全程天数、班期、备注 |
| StamplessEntry 票戳组合 | `frontend/src/types/stampentry.ts` | 所属封、邮票名称、面值、发行年份、齿度、变体、封上位置 |

另有 `frontend/src/types/asset.ts`：戳样与封的正反面原图在 IndexedDB 中**单独建表**（`assets`）。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 重定向到 `/postmarks` | — |
| `/postmarks` | 邮戳目录（按戳型、局所、年代区间筛选，图片墙 ↔ 列表切换） | Postmark |
| `/covers` | 实寄封目录（按收寄地、年代、品相、是否给据筛选，行内显示贴票枚数与关联邮戳数） | Cover |
| `/covers/:id` | 实寄封详情（正反面图、票戳组合表、寄递事实时间轴） | Cover、StamplessEntry、PostalRoute |
| `/routes/:id` | 邮路编辑器（节点拖拽排序、增删中转地、按节点日期自动算全程天数） | PostalRoute |
| `/search` | 综合检索（跨三类按关键词与年代分组检索） | Postmark、Cover、PostalRoute |

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `StampCard.vue`、`CoverCard.vue`、`RouteTimeline.vue`、`ScarceTag.vue`
- hooks：`frontend/src/hooks/useCatalogFilter.ts`（统一过滤与排序）、`frontend/src/hooks/useCoverRoute.ts`（寄递时间轴与在途天数）
- utils：`frontend/src/utils/db.ts`（Dexie 封装/版本迁移/样例数据）、`frontend/src/utils/dateRange.ts`（年代区间、干支互转、日期先后校验）、`frontend/src/utils/id.ts`（编目号与唯一键）、`frontend/src/utils/draft.ts`（localStorage 草稿）

## 六、本地开发（可选，需要本机 Node 20+）

```bash
cd frontend
npm install
npm run dev          # http://localhost:21824
npm run build        # vue-tsc 类型检查 + vite 构建
```

## 七、目录结构

```
sologsb-1124/
├── docker-compose.yml
├── .env.example / .env
├── README.md
└── frontend/
    ├── Dockerfile          # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf          # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/          # postmark / cover / route / stampentry / asset
        ├── stores/         # postmarkStore / coverStore / routeStore
        ├── components/common/
        ├── hooks/
        ├── pages/
        ├── router/
        ├── utils/
        ├── styles/
        ├── App.vue
        └── main.ts
```

## 八、数据存储说明

- **编目数据**：IndexedDB（Dexie，库名 `gbpostmark`）。表结构含版本号，`version(2)` 会把戳样与封图迁移到独立的 `assets` 表并补齐历史记录缺省字段；`version(3)` 加入修订基线合并：四类记录补 `rev`、邮路补 `nodesRev`、实寄封补 `timelineBaseRev`，并新增 `mergeConflicts` 表；旧数据按「节点与封当前一致」补基线（已挂接封对齐所属邮路当前 `nodesRev`，升级后不会被误判失效）。首次运行写入样例数据，便于直接查看各页面效果。
- **表单草稿**：localStorage，键名前缀 `gbpostmark:draft:`（邮戳、实寄封、邮路各一份），刷新或误关页面后可恢复，可一键清除。
- **无后端**：不请求任何外部接口，容器无状态，不使用数据库服务与命名卷；清除浏览器站点数据即等于清空数据。

## 九、多标签页修订基线合并（v3）

邮路、实寄封、票戳组合可在多个浏览器标签页同时编辑，统一按「修订基线」做三向合并，避免后保存覆盖先保存、以及时间轴与综合检索出现两套结果：

| 机制 | 说明 |
| --- | --- |
| 修订号 `rev` | 每条记录的合并基线；保存时带本页打开时看到的基线，与库内当前值做三向合并。互不冲突的字段直接并入；同一字段两边改成不同值时**保留先保存值**并返回冲突字段提示，不静默覆盖。 |
| 节点修订 `nodesRev` | 邮路单独维护：只有节点增删/改日期/排序才自增（改名称、班期不影响时间轴）。 |
| 时间轴基线 `timelineBaseRev` | 挂接封保存/挂接时对齐所属邮路 `nodesRev`。节点一旦改动，所有挂接封基线立即落后，**封详情时间轴立即失效**（旧轴置灰 + 醒目标注）、**综合检索暂停这些封的命中**；核对后点「补基线」即恢复。 |
| 挂接待裁定 | 同一封被两个页面基于同一基线挂到**不同邮路**时，先保存挂接生效，后保存主张写入 `mergeConflicts` 表列为**待裁定**；邮路页标题与顶栏显示待裁定数，可在面板选择「改挂后保存 / 维持先保存」，裁决时按目标邮路当前 `nodesRev` 重对齐基线。 |
| 跨标签页通知 | `utils/revisionBus.ts` 借 localStorage `storage` 事件广播修订，其它标签页即时重载对应 store；重新可见标签页时再兜底刷新一次。 |
| 写失败回滚 + 可恢复草稿 | 所有多表写入均在 Dexie 事务内，失败整体回滚；失败的写入内容另存到 localStorage（前缀 `gbpostmark:recover:`，含失败原因与基线），重新进入页面可一键恢复重试。 |
| 统一派生出口 | `utils/timelineStatus.ts` 同时供封详情与综合检索使用：时间轴有效/失效判定、检索代表年份均取同一时间轴来源，避免两套年代结果。 |

校验脚本（仅本地开发，使用 `tsx` + `fake-indexeddb`）：

```bash
cd frontend
npm run check:revision   # 三向合并 / 失效判定 / 统一年份的纯逻辑断言
npm run check:db         # v2→v3 迁移补基线、挂接冲突、节点失效、补基线恢复的端到端冒烟
```
